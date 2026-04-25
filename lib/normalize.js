"use strict";

// Body normalizer for upstream /v1/chat/completions requests.
//
// The ToCodex VSCode extension (v3.1.3) always constructs a chat.completions
// body that looks EXACTLY like this (see class `xB` in dist/extension.js):
//
//   {
//     model,
//     max_tokens,
//     temperature,
//     messages: [{role:"system", content}, ...],
//     stream: true,
//     stream_options: { include_usage: true },    // only when stream
//     reasoning,                                  // optional
//     tools,                                      // optional
//     tool_choice,                                // optional
//   }
//
// Incoming requests from Claude Code / Cursor / OneAPI / LobeChat / arbitrary
// OpenAI clients routinely carry extra fields the extension never emits:
//   - cache_control / ephemeral / anthropic-beta wrappers
//   - parallel_tool_calls, response_format, seed, logit_bias, stop, top_p,
//     frequency_penalty, presence_penalty, n, user, service_tier, store
//   - metadata, extra_headers / extra_query
//   - "system" as a root array (Anthropic-style) instead of a messages[0]
//     with role:"system"
//   - message content that is an array of parts with unsupported types
//     ("thinking", "redacted_thinking", "image_url" nested, etc.)
//
// Any of those could be used by upstream scoring as an anomaly signal.  We
// therefore filter every /v1/chat/completions body through this allowlist
// before sending.  The filter is deliberately strict: unknown keys are
// dropped silently; message parts are normalized to OpenAI's basic shape.

const { sanitizeToolSchema } = require("./openai-schema");

const ROOT_ALLOW = new Set([
  "model",
  "max_tokens",
  "temperature",
  "messages",
  "stream",
  "stream_options",
  "reasoning",
  "tools",
  "tool_choice",
  // Image-fallback chat requests (lUe() in the extension) carry this
  // field.  When present, it's the signal that this is NOT a normal chat
  // and must travel through the images-chat profile.
  "modalities",
]);

const MSG_ROLES = new Set(["system", "user", "assistant", "tool"]);
const MSG_FIELDS = new Set([
  "role",
  "content",
  "name",
  "tool_call_id",
  "tool_calls",
]);

// Keep these content-part types.  Anything else becomes plain text if we
// can extract a .text field, otherwise dropped.
const PART_TYPES_KEEP = new Set(["text", "image_url"]);

function normalizeContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  const parts = [];
  for (const raw of content) {
    if (raw == null) continue;
    if (typeof raw === "string") {
      parts.push({ type: "text", text: raw });
      continue;
    }
    if (typeof raw !== "object") continue;
    const { type } = raw;

    if (type === "text" && typeof raw.text === "string") {
      parts.push({ type: "text", text: raw.text });
      continue;
    }
    if (type === "image_url" && raw.image_url) {
      const url = typeof raw.image_url === "string" ? raw.image_url : raw.image_url.url;
      if (url) parts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    if (type === "image" && raw.source && raw.source.data) {
      // Anthropic-shaped inline image — convert to OpenAI data URL.
      const media = raw.source.media_type || "image/png";
      parts.push({
        type: "image_url",
        image_url: { url: `data:${media};base64,${raw.source.data}` },
      });
      continue;
    }

    // "tool_use" / "tool_result" / "thinking" / etc. —— rescue any text we
    // can see, drop the rest so the OpenAI schema stays clean.
    if (typeof raw.text === "string") {
      parts.push({ type: "text", text: raw.text });
    }
  }

  // Collapse all-text to a plain string (what the extension emits for
  // system / user messages that are pure text).
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => p.text).join("");
  }
  // Only image parts survived? Still return the array.
  return parts;
}

function normalizeMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const role = MSG_ROLES.has(msg.role) ? msg.role : null;
  if (!role) return null;

  const out = { role };
  out.content = normalizeContent(msg.content);

  if (role === "tool" && typeof msg.tool_call_id === "string") {
    out.tool_call_id = msg.tool_call_id;
  }
  if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    const tcs = [];
    for (const tc of msg.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      if (!tc.function || typeof tc.function !== "object") continue;
      const args = tc.function.arguments;
      tcs.push({
        id: String(tc.id || ""),
        type: "function",
        function: {
          name: String(tc.function.name || ""),
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        },
      });
    }
    if (tcs.length) out.tool_calls = tcs;
  }
  if (typeof msg.name === "string" && msg.name) out.name = msg.name;

  // Drop anything the OpenAI chat schema doesn't know about: cache_control,
  // ephemeral, metadata, stainless_*, etc.
  for (const k of Object.keys(msg)) {
    if (!MSG_FIELDS.has(k)) {
      /* silently dropped */
    }
  }

  return out;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    if (t.type !== "function" || !t.function) continue;
    const fn = t.function;
    const entry = {
      type: "function",
      function: {
        name: String(fn.name || ""),
        description: typeof fn.description === "string" ? fn.description : undefined,
        parameters:
          fn.parameters && typeof fn.parameters === "object"
            ? sanitizeToolSchema(fn.parameters)
            : undefined,
      },
    };
    if (entry.function.description === undefined) delete entry.function.description;
    if (entry.function.parameters === undefined) delete entry.function.parameters;
    if (entry.function.name) out.push(entry);
  }
  return out.length ? out : undefined;
}

function normalizeToolChoice(tc) {
  if (tc == null) return undefined;
  if (tc === "auto" || tc === "none" || tc === "required") return tc;
  if (typeof tc === "object" && tc.type === "function" && tc.function?.name) {
    return { type: "function", function: { name: String(tc.function.name) } };
  }
  return undefined;
}

function normalizeReasoning(r) {
  if (!r || typeof r !== "object") return undefined;
  // The extension emits `{ effort: "low"|"medium"|"high" }` or similar.
  const out = {};
  if (typeof r.effort === "string") out.effort = r.effort;
  if (typeof r.budget === "number") out.budget = r.budget;
  return Object.keys(out).length ? out : undefined;
}

function normalizeChatBody(body, { defaultModel } = {}) {
  if (!body || typeof body !== "object") {
    throw Object.assign(new Error("invalid request body"), { statusCode: 400 });
  }

  const out = {};
  out.model =
    (typeof body.model === "string" && body.model) ||
    (typeof defaultModel === "string" && defaultModel) ||
    undefined;
  if (!out.model) {
    throw Object.assign(new Error("missing 'model'"), { statusCode: 400 });
  }

  // Accept either `max_tokens` or Anthropic's `max_output_tokens`.
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  else if (typeof body.max_output_tokens === "number") out.max_tokens = body.max_output_tokens;

  if (typeof body.temperature === "number") out.temperature = body.temperature;

  // Hoist Anthropic-style top-level `system` string into messages[0].
  let messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  if (typeof body.system === "string" && body.system.trim()) {
    messages.unshift({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const sys = body.system
      .map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
    if (sys) messages.unshift({ role: "system", content: sys });
  }

  out.messages = messages.map(normalizeMessage).filter(Boolean);
  if (!out.messages.length) {
    throw Object.assign(new Error("messages is empty after normalization"), {
      statusCode: 400,
    });
  }

  const stream = !!body.stream;
  if (stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }

  const reasoning = normalizeReasoning(body.reasoning);
  if (reasoning) out.reasoning = reasoning;

  const tools = normalizeTools(body.tools);
  if (tools) out.tools = tools;

  const toolChoice = normalizeToolChoice(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  // Image-fallback chat body: keep modalities verbatim if it's
  // ["image","text"] or ["text","image"] — this is exactly what lUe()
  // sends.  Any other shape is rejected (unknown modality values would
  // be a giveaway).
  if (Array.isArray(body.modalities)) {
    const allowed = body.modalities.filter((x) => x === "image" || x === "text");
    if (allowed.length) out.modalities = allowed;
  }

  // Enforce allowlist — any accidentally surviving unknown field is stripped.
  for (const k of Object.keys(out)) {
    if (!ROOT_ALLOW.has(k)) delete out[k];
  }
  return out;
}

module.exports = {
  normalizeChatBody,
  normalizeMessage,
  normalizeContent,
  normalizeTools,
  normalizeToolChoice,
  ROOT_ALLOW,
};
