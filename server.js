"use strict";

// ToCodex API relay — main entry.
//
// Dispatches incoming HTTP requests to one of three paths:
//
//   * OpenAI-style passthrough  (POST /v1/chat/completions, GET /v1/models, ...)
//       → signs the upstream request if needed and streams the response body
//         back to the client untouched. Zero JSON parsing. NewAPI / OneAPI /
//         plain OpenAI clients use this.
//
//   * Anthropic Messages        (POST /anthropic/v1/messages,
//                                POST /anthropic/v1/messages/count_tokens,
//                                GET  /anthropic/v1/models)
//       → translates the client payload to OpenAI chat.completions, signs it,
//         and translates the streamed response back to Anthropic SSE.
//
//   * OpenAI Responses          (POST /v1/responses)
//       → translates the client payload to OpenAI chat.completions (with
//         optional previous_response_id history replay), signs it, and
//         translates the streamed response back to Responses SSE.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

const { loadConfig, upstreamUrl } = require("./lib/sign");
const { buildUpstreamHeaders } = require("./lib/headers");
const { normalizeChatBody } = require("./lib/normalize");
const httpClient = require("./lib/http-client");
const { resolveApiKey, readJsonBody, readRawBody, newId, safeJsonParse } = require("./lib/util");
const { parseOpenAISSE, formatDone } = require("./lib/sse");
const {
  ANTHROPIC_VERSION,
  anthropicRequestToOpenAI,
  openaiResponseToAnthropic,
  anthropicErrorPayload,
  countTokensEstimate,
  anthropicStreamFromOpenAI,
} = require("./lib/anthropic");
const {
  SessionStore,
  responsesRequestToOpenAI,
  openaiResponseToResponses,
  responsesStreamFromOpenAI,
  assistantMessageFromOpenaiChoice,
} = require("./lib/responses");

loadDotEnv(path.join(process.cwd(), ".env"));

const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";
const LISTEN_PORT = toPort(process.env.PORT || process.env.LISTEN_PORT || "8787");
const HEALTH_PATH = normalizePrefix(process.env.HEALTH_PATH || "/_health");
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "*";
const CORS_ALLOW_HEADERS =
  process.env.CORS_ALLOW_HEADERS ||
  "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta";
const CORS_ALLOW_METHODS = process.env.CORS_ALLOW_METHODS || "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const UPSTREAM_TIMEOUT_MS = toPositiveInt(process.env.UPSTREAM_TIMEOUT_MS || "600000");
const SESSION_TTL_MS = toPositiveInt(process.env.RESPONSES_SESSION_TTL_MS || "1800000");
const SESSION_MAX = toPositiveInt(process.env.RESPONSES_SESSION_MAX || "500");

const CONFIG = loadConfig(process.env);
const SESSIONS = new SessionStore({ ttlMs: SESSION_TTL_MS, max: SESSION_MAX });

// Headers never copied in either direction.
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

// Response headers dropped before forwarding (Node's fetch already
// decompressed the body — see git log for gzip bug context).
const upstreamStripResponseHeaders = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  addCorsHeaders(res);

  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "invalid_request", requestId });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const incomingUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = incomingUrl.pathname;

  // --- Health ------------------------------------------------------------
  if (p === HEALTH_PATH || p === "/health" || p === "/") {
    sendJson(res, 200, {
      ok: true,
      upstream: CONFIG.apiUrl.toString(),
      signingScheme: "HMAC-SHA256(secret, `${ts}:${nonce}:${METHOD}:${path}`)",
      signedPaths: CONFIG.signAllPaths ? "*" : Array.from(CONFIG.signedPaths),
      fixes: {
        responseUsageTotalTokens: true,
        anthropicClaudeModelMapping: true,
        toolSchemaSanitizer: ["strip_dollar_keys", "fill_array_items"],
      },
      routes: {
        openai_chat: ["POST /v1/chat/completions", "GET /v1/models"],
        openai_responses: ["POST /v1/responses"],
        anthropic: [
          "POST /anthropic/v1/messages",
          "POST /anthropic/v1/messages/count_tokens",
          "GET /anthropic/v1/models",
        ],
      },
      requestId,
    });
    return;
  }

  try {
    // --- Anthropic translator routes ------------------------------------
    if (p === "/anthropic/v1/messages" && req.method === "POST") {
      await handleAnthropicMessages(req, res, requestId);
      return;
    }
    if (p === "/anthropic/v1/messages/count_tokens" && req.method === "POST") {
      await handleAnthropicCountTokens(req, res);
      return;
    }
    if (p === "/anthropic/v1/models" && req.method === "GET") {
      await handleAnthropicModels(req, res, requestId);
      return;
    }

    // --- Responses translator route -------------------------------------
    if (p === "/v1/responses" && req.method === "POST") {
      await handleResponses(req, res, requestId);
      return;
    }

    // --- OpenAI passthrough (default) -----------------------------------
    await handlePassthrough(req, res, incomingUrl, requestId);
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    console.error(`[${requestId}] handler error:`, error);
    if (!res.headersSent) {
      sendJson(res, statusCode, {
        error: "handler_error",
        message: error instanceof Error ? error.message : String(error),
        requestId,
      });
    }
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`ToCodex relay listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`upstream: ${CONFIG.apiUrl.toString()}`);
  console.log(
    `signed paths: ${CONFIG.signAllPaths ? "*" : Array.from(CONFIG.signedPaths).join(", ")}`
  );
  console.log(`routes: OpenAI (/v1), Anthropic (/anthropic/v1), Responses (/v1/responses)`);
});

// --- OpenAI passthrough ------------------------------------------------------

async function handlePassthrough(req, res, incomingUrl, requestId) {
  const upstreamPath = incomingUrl.pathname.startsWith("/")
    ? incomingUrl.pathname
    : `/${incomingUrl.pathname}`;
  const targetUrl = upstreamUrl(CONFIG, `${upstreamPath}${incomingUrl.search}`);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("upstream timeout")),
    UPSTREAM_TIMEOUT_MS
  );
  res.on("close", () => {
    if (!res.writableEnded) controller.abort(new Error("client disconnected"));
  });

  try {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    // Buffer the client body so we can author a byte-exact upstream request
    // (strict impersonation forbids copying any client header, including
    // Content-Length from the original request — we compute our own).
    let bodyBuf;
    if (hasBody) {
      try {
        bodyBuf = await readRawBody(req);
      } catch (e) {
        sendJson(res, e.statusCode || 400, {
          error: "invalid_request",
          message: e.message,
          requestId,
        });
        return;
      }
    }

    // Detect stream intent and image-fallback hint by sniffing the JSON
    // body when possible.  Real ToCodex extension chooses between the SDK
    // chat path and the lUe() image-fallback path based on presence of
    // `modalities: ["image","text"]` in the body — we have to mirror that.
    let stream = false;
    let bodyHint;
    if (hasBody && bodyBuf && bodyBuf.length) {
      const parsed = safeJsonParse(bodyBuf);
      stream = !!(parsed && parsed.stream);
      bodyHint = parsed || undefined;

      // For /v1/chat/completions and /v1/images/generations we rewrite the
      // body through the strict normalizer so the upstream sees the exact
      // shape the real extension would have sent — regardless of what the
      // client tried to smuggle in (cache_control, x-stainless metadata,
      // Anthropic-style system blocks, etc.).
      if (parsed && upstreamPath === "/v1/chat/completions") {
        try {
          const normalized = normalizeChatBody(parsed, { defaultModel: CONFIG.defaultModel });
          bodyBuf = Buffer.from(JSON.stringify(normalized));
          stream = !!normalized.stream;
          bodyHint = normalized;
        } catch (e) {
          sendJson(res, e.statusCode || 400, {
            error: "invalid_request",
            message: e.message,
            requestId,
          });
          return;
        }
      }
    }

    const apiKey = resolveApiKey(req, CONFIG);
    const taskIdHeader = req.headers["x-roo-task-id"];
    const taskId = Array.isArray(taskIdHeader) ? taskIdHeader[0] : taskIdHeader;

    const headers = buildUpstreamHeaders(CONFIG, {
      path: upstreamPath,
      method: req.method,
      apiKey,
      taskId,
      stream,
      hasBody,
      bodyHint,
      contentLength: hasBody ? bodyBuf.length : undefined,
    });

    const upstreamResponse = await httpClient.request(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? bodyBuf : undefined,
      signal: controller.signal,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });

    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      if (value == null) continue;
      const lower = key.toLowerCase();
      if (hopByHopHeaders.has(lower)) continue;
      if (upstreamStripResponseHeaders.has(lower)) continue;
      res.setHeader(key, value);
    }
    res.writeHead(upstreamResponse.status, upstreamResponse.statusText);

    const bodyStream = upstreamResponse.body;
    if (!bodyStream) {
      res.end();
      return;
    }
    bodyStream.on("error", (error) => {
      if (!res.writableEnded) {
        console.error(`[${requestId}] upstream body error:`, error);
        res.destroy(error);
      }
    });
    bodyStream.pipe(res);
  } catch (error) {
    const statusCode = error?.code === "ETIMEDOUT" || error?.name === "AbortError" ? 504 : 502;
    console.error(`[${requestId}] relay error:`, error);
    if (!res.headersSent) {
      sendJson(res, statusCode, {
        error: "upstream_request_failed",
        message: error instanceof Error ? error.message : String(error),
        requestId,
      });
    } else {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  } finally {
    clearTimeout(timeout);
  }
}

// --- Upstream helper for translator routes ----------------------------------

// Run a fully-translated OpenAI chat.completions request against the upstream.
// Returns:
//   - if stream: { stream: true, response, close() } — response.body is a web
//     ReadableStream of SSE bytes; caller is responsible for draining it.
//   - if non-stream: { stream: false, status, json }
// On upstream error with status >= 400, returns { stream:false, status, json }
// with the decoded error body.
async function callUpstreamChat(apiKey, translatedBody, { taskId } = {}) {
  const upstreamPath = "/v1/chat/completions";
  // The translator layers already hand us a chat.completions-shaped payload,
  // but we still push it through the strict normalizer so the final wire
  // bytes match the real extension exactly (consistent field set / order).
  let normalized;
  try {
    normalized = normalizeChatBody(translatedBody, { defaultModel: CONFIG.defaultModel });
  } catch (e) {
    return {
      stream: false,
      status: e.statusCode || 400,
      json: { error: { message: e.message, type: "invalid_request_error" } },
      cleanup: () => {},
    };
  }
  const bodyBuf = Buffer.from(JSON.stringify(normalized));
  const headers = buildUpstreamHeaders(CONFIG, {
    path: upstreamPath,
    method: "POST",
    apiKey,
    taskId,
    stream: !!normalized.stream,
    hasBody: true,
    contentLength: bodyBuf.length,
  });

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("upstream timeout")),
    UPSTREAM_TIMEOUT_MS
  );

  try {
    const resp = await httpClient.request(upstreamUrl(CONFIG, upstreamPath), {
      method: "POST",
      headers,
      body: bodyBuf,
      signal: controller.signal,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });

    if (resp.status >= 400) {
      const buf = await httpClient.readAll(resp.body);
      const text = buf.toString("utf8");
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: { message: text || `upstream ${resp.status}` } };
      }
      return { stream: false, status: resp.status, json, cleanup: () => clearTimeout(timeout) };
    }

    if (normalized.stream) {
      return {
        stream: true,
        response: { body: resp.body },
        cleanup: () => clearTimeout(timeout),
      };
    }

    const json = await httpClient.readJson(resp.body);
    return { stream: false, status: resp.status, json, cleanup: () => clearTimeout(timeout) };
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// --- Anthropic routes --------------------------------------------------------

async function handleAnthropicMessages(req, res, requestId) {
  const apiKey = resolveApiKey(req, CONFIG);
  if (!apiKey) {
    sendJson(res, 401, anthropicErrorPayload(401, { message: "missing api key" }));
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, e.statusCode || 400, anthropicErrorPayload(400, { message: e.message }));
    return;
  }

  let translated;
  try {
    translated = anthropicRequestToOpenAI(body, { defaultModel: CONFIG.defaultModel });
  } catch (e) {
    sendJson(res, e.statusCode || 400, anthropicErrorPayload(400, { message: e.message }));
    return;
  }

  const requestedModel = translated.model;
  let upstream;
  try {
    upstream = await callUpstreamChat(apiKey, translated, {
      taskId: req.headers["x-roo-task-id"],
    });
  } catch (e) {
    console.error(`[${requestId}] anthropic upstream error:`, e);
    sendJson(res, 502, anthropicErrorPayload(502, { message: e.message || "upstream error" }));
    return;
  }

  try {
    if (!upstream.stream) {
      if (upstream.status >= 400) {
        res.setHeader("anthropic-version", ANTHROPIC_VERSION);
        sendJson(res, upstream.status, anthropicErrorPayload(upstream.status, upstream.json));
        return;
      }
      res.setHeader("anthropic-version", ANTHROPIC_VERSION);
      sendJson(res, 200, openaiResponseToAnthropic(upstream.json, requestedModel));
      return;
    }

    // Streaming: pipe the translated SSE frames to the client.
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("anthropic-version", ANTHROPIC_VERSION);
    res.writeHead(200);

    const bodyStream = upstream.response.body;
    if (!bodyStream) {
      res.end();
      return;
    }
    const payloads = parseOpenAISSE(bodyStream);
    const translatedStream = anthropicStreamFromOpenAI(payloads, requestedModel);
    for await (const chunk of translatedStream) {
      if (res.writableEnded) break;
      res.write(chunk);
    }
    res.end();
  } finally {
    if (upstream.cleanup) upstream.cleanup();
  }
}

async function handleAnthropicCountTokens(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, e.statusCode || 400, anthropicErrorPayload(400, { message: e.message }));
    return;
  }
  const tokens = countTokensEstimate(body);
  res.setHeader("anthropic-version", ANTHROPIC_VERSION);
  sendJson(res, 200, { input_tokens: tokens });
}

async function handleAnthropicModels(req, res, requestId) {
  // Fetch /v1/models from upstream (unsigned by default), rewrap into Anthropic shape.
  const apiKey = resolveApiKey(req, CONFIG);
  const headers = buildUpstreamHeaders(CONFIG, {
    path: "/v1/models",
    method: "GET",
    apiKey,
    stream: false,
    hasBody: false,
  });
  try {
    const resp = await httpClient.request(upstreamUrl(CONFIG, "/v1/models"), {
      method: "GET",
      headers,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (resp.status >= 400) {
      res.setHeader("anthropic-version", ANTHROPIC_VERSION);
      const text = (await httpClient.readAll(resp.body)).toString("utf8");
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
      sendJson(res, resp.status, anthropicErrorPayload(resp.status, payload));
      return;
    }
    const payload = await httpClient.readJson(resp.body);
    const data = Array.isArray(payload.data) ? payload.data : [];
    res.setHeader("anthropic-version", ANTHROPIC_VERSION);
    sendJson(res, 200, {
      data: data.map((m) => ({
        type: "model",
        id: m.id,
        display_name: m.id,
        created_at: m.created ? new Date(m.created * 1000).toISOString() : null,
      })),
      has_more: false,
      first_id: data[0] && data[0].id,
      last_id: data.length ? data[data.length - 1].id : null,
    });
  } catch (e) {
    console.error(`[${requestId}] anthropic models error:`, e);
    sendJson(res, 502, anthropicErrorPayload(502, { message: e.message || "upstream error" }));
  }
}

// --- Responses route ---------------------------------------------------------

async function handleResponses(req, res, requestId) {
  const apiKey = resolveApiKey(req, CONFIG);
  if (!apiKey) {
    sendJson(res, 401, { error: { message: "missing api key", type: "authentication_error" } });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, e.statusCode || 400, {
      error: { message: e.message, type: "invalid_request_error" },
    });
    return;
  }

  const history = SESSIONS.get(body.previous_response_id);

  let translated;
  try {
    translated = responsesRequestToOpenAI(body, history, { defaultModel: CONFIG.defaultModel });
  } catch (e) {
    sendJson(res, e.statusCode || 400, {
      error: { message: e.message, type: "invalid_request_error" },
    });
    return;
  }
  const requestedModel = translated.model;

  let upstream;
  try {
    upstream = await callUpstreamChat(apiKey, translated, {
      taskId: req.headers["x-roo-task-id"],
    });
  } catch (e) {
    console.error(`[${requestId}] responses upstream error:`, e);
    sendJson(res, 502, { error: { message: e.message || "upstream error", type: "api_error" } });
    return;
  }

  try {
    if (!upstream.stream) {
      if (upstream.status >= 400) {
        sendJson(res, upstream.status, upstream.json);
        return;
      }
      const converted = openaiResponseToResponses(upstream.json, requestedModel);
      // Persist history so the next call's previous_response_id works.
      const choice = (upstream.json.choices && upstream.json.choices[0]) || {};
      const nextHistory = (history || []).slice();
      nextHistory.push(...translated.messages.filter((m) => m.role !== "system"));
      nextHistory.push(assistantMessageFromOpenaiChoice(choice));
      SESSIONS.put(converted.id, nextHistory);
      sendJson(res, 200, converted);
      return;
    }

    // Streaming
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.writeHead(200);

    const bodyStream = upstream.response.body;
    if (!bodyStream) {
      res.end();
      return;
    }
    const payloads = parseOpenAISSE(bodyStream);
    const responseId = newId("resp");
    const translatedStream = responsesStreamFromOpenAI(payloads, requestedModel, responseId);

    // Accumulate the assistant message as we stream so we can snapshot the
    // full history when the stream completes. The generator uses a `return`
    // value to hand back the assembled assistant message; for-await doesn't
    // expose that directly, so we accumulate text here as a simple proxy.
    const textChunks = [];
    const toolCallsByIdx = new Map();
    // Light tap on the upstream stream to harvest content for history.
    // Easiest approach: translate and tap in parallel by iterating manually.
    const iter = translatedStream[Symbol.asyncIterator]();
    // We also need to read the raw OpenAI payloads for history accumulation;
    // since `payloads` is already consumed by the translator, we reconstruct
    // from the translator's own emitted events.
    while (true) {
      const { value, done } = await iter.next();
      if (done) break;
      if (res.writableEnded) break;
      res.write(value);
      // Best-effort history capture by sniffing event types
      try {
        const frame = value.toString("utf8");
        // Only look for output_text deltas to keep history useful; tool call
        // args are captured via response.output_item.done below.
        const m = frame.match(/"type":"response\.output_text\.delta"[\s\S]*?"delta":"([\s\S]*?)"\}\n/);
        if (m) textChunks.push(JSON.parse(`"${m[1]}"`));
        const tdone = frame.match(
          /"type":"response\.output_item\.done"[\s\S]*?"function_call"[\s\S]*?"call_id":"(.*?)"[\s\S]*?"name":"(.*?)"[\s\S]*?"arguments":"([\s\S]*?)"/
        );
        if (tdone) {
          toolCallsByIdx.set(tdone[1], {
            id: tdone[1],
            type: "function",
            function: { name: tdone[2], arguments: JSON.parse(`"${tdone[3]}"`) },
          });
        }
      } catch {
        /* history sniffing is best-effort */
      }
    }
    res.end();

    // Snapshot history for next turn.
    const nextHistory = (history || []).slice();
    nextHistory.push(...translated.messages.filter((m) => m.role !== "system"));
    const assistantMsg = { role: "assistant", content: textChunks.join("") };
    if (toolCallsByIdx.size) assistantMsg.tool_calls = Array.from(toolCallsByIdx.values());
    nextHistory.push(assistantMsg);
    SESSIONS.put(responseId, nextHistory);
  } finally {
    if (upstream.cleanup) upstream.cleanup();
  }
}

// --- Helpers ----------------------------------------------------------------

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function addCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
}

function sendJson(res, statusCode, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.writeHead(statusCode);
  res.end(JSON.stringify(payload, null, 2));
}

function normalizePrefix(value) {
  if (!value || value === "/") return "/";
  let normalized = value.startsWith("/") ? value : `/${value}`;
  normalized = normalized.replace(/\/+$/u, "");
  return normalized || "/";
}

function toPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}

function toPositiveInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return Math.floor(number);
}

// `formatDone` is exported for future use (SSE-final terminator); silence lint.
void formatDone;
