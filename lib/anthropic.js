"use strict";

// Anthropic Messages <-> OpenAI chat.completions translator.
//
// Intentionally scoped to the subset Claude Code actually uses: text,
// base64 images, tool_use (assistant tool calls), tool_result (user tool
// responses), tools / tool_choice. Logic mirrors the Python reference
// implementation we analysed.

const { flattenContentToText, normalizeOpenAIContent, sanitizeToolSchema } = require("./openai-schema");
const { newId } = require("./util");
const { formatNamedSSE } = require("./sse");

const ANTHROPIC_VERSION = "2023-06-01";

// ---------- Request: Anthropic → OpenAI ----------------------------------

function anthropicSystemToText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === "string" ? b : b && b.type === "text" ? b.text || "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// Turn an Anthropic user message's content (array) into one OR MORE OpenAI
// messages: text+images become a single user message, while each tool_result
// is promoted to its own role:"tool" message.
function anthropicUserContentToOpenAIMessages(content) {
  if (content == null) return [{ role: "user", content: "" }];
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) return [{ role: "user", content: flattenContentToText(content) }];

  const messages = [];
  const userParts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      if (typeof item === "string") userParts.push({ type: "text", text: item });
      continue;
    }
    if (item.type === "tool_result") {
      // Flush pending user-text first so chronological order is preserved.
      flushUser(messages, userParts);
      messages.push({
        role: "tool",
        tool_call_id: item.tool_use_id || item.id || "",
        content: flattenContentToText(item.content) || "",
      });
    } else if (item.type === "text") {
      if (typeof item.text === "string") userParts.push({ type: "text", text: item.text });
    } else if (item.type === "image") {
      const url = imageBlockToUrl(item);
      if (url) userParts.push({ type: "image_url", image_url: { url } });
    }
    // other block types ignored
  }
  flushUser(messages, userParts);
  if (messages.length === 0) messages.push({ role: "user", content: "" });
  return messages;
}

function flushUser(messages, userParts) {
  if (userParts.length === 0) return;
  let content;
  if (userParts.length === 1 && userParts[0].type === "text") content = userParts[0].text;
  else content = userParts.slice();
  messages.push({ role: "user", content });
  userParts.length = 0;
}

function imageBlockToUrl(block) {
  const src = block.source;
  if (!src || typeof src !== "object") return null;
  if (src.type === "base64") {
    return `data:${src.media_type || "image/png"};base64,${src.data || ""}`;
  }
  if (src.type === "url" && src.url) return src.url;
  return null;
}

// An Anthropic assistant message collapses to ONE OpenAI assistant message;
// text blocks become `content`, tool_use blocks become `tool_calls`.
function anthropicAssistantContentToOpenAIMessage(content) {
  const msg = { role: "assistant", content: "" };
  if (content == null) return msg;
  if (typeof content === "string") {
    msg.content = content;
    return msg;
  }
  if (!Array.isArray(content)) return msg;

  const textChunks = [];
  const toolCalls = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      textChunks.push(item.text);
    } else if (item.type === "tool_use") {
      toolCalls.push({
        id: item.id || newId("call"),
        type: "function",
        function: {
          name: item.name || "",
          arguments: JSON.stringify(item.input ?? {}),
        },
      });
    }
  }
  if (textChunks.length) msg.content = textChunks.join("");
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return msg;
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: sanitizeToolSchema(t.input_schema || { type: "object", properties: {} }),
    },
  }));
}

function anthropicToolChoiceToOpenAI(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto" || choice === "any") return "auto";
    return choice;
  }
  if (typeof choice === "object") {
    if (choice.type === "auto" || choice.type === "any") return "auto";
    if (choice.type === "tool" && choice.name) {
      return { type: "function", function: { name: choice.name } };
    }
  }
  return undefined;
}

function resolveAnthropicModel(model, defaultModel) {
  const requested = typeof model === "string" ? model.trim() : "";
  const fallback = typeof defaultModel === "string" ? defaultModel.trim() : "";

  // Claude clients normally send Anthropic model ids, but the upstream speaks
  // OpenAI chat-completions model ids. Let deployments pin the real upstream
  // model without breaking clients that already pass a ToCodex/OpenAI model.
  if (requested.startsWith("claude-") && fallback) return fallback;
  return requested || fallback;
}

function anthropicRequestToOpenAI(payload, { defaultModel } = {}) {
  const out = { messages: [], stream: !!payload.stream };

  const sys = anthropicSystemToText(payload.system);
  if (sys) out.messages.push({ role: "system", content: sys });

  for (const msg of payload.messages || []) {
    const role = msg.role || "user";
    if (role === "assistant") {
      out.messages.push(anthropicAssistantContentToOpenAIMessage(msg.content));
    } else {
      out.messages.push(...anthropicUserContentToOpenAIMessages(msg.content));
    }
  }

  out.model = resolveAnthropicModel(payload.model, defaultModel);
  if (!out.model) throw httpError(400, "missing model (set TOCODEX_DEFAULT_MODEL or pass `model`)");

  if (typeof payload.max_tokens === "number") out.max_tokens = payload.max_tokens;
  if (typeof payload.temperature === "number") out.temperature = payload.temperature;
  if (typeof payload.top_p === "number") out.top_p = payload.top_p;
  if (Array.isArray(payload.stop_sequences) && payload.stop_sequences.length)
    out.stop = payload.stop_sequences;

  const tools = anthropicToolsToOpenAI(payload.tools);
  if (tools && tools.length) out.tools = tools;
  const choice = anthropicToolChoiceToOpenAI(payload.tool_choice);
  if (choice !== undefined) out.tool_choice = choice;

  if (out.stream) out.stream_options = { include_usage: true };

  return out;
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// ---------- Response: OpenAI → Anthropic ---------------------------------

function openaiFinishReasonToAnthropic(reason) {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return reason || "end_turn";
  }
}

function openaiResponseToAnthropic(payload, requestedModel) {
  const choice = (payload.choices && payload.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === "string" && msg.content) {
    content.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      }
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const fn = tc.function || {};
      let input;
      try {
        input = fn.arguments ? JSON.parse(fn.arguments) : {};
      } catch {
        input = { _raw: fn.arguments || "" };
      }
      content.push({
        type: "tool_use",
        id: tc.id || newId("call"),
        name: fn.name || "",
        input,
      });
    }
  }

  return {
    id: payload.id || newId("msg"),
    type: "message",
    role: "assistant",
    model: requestedModel || payload.model || "",
    content,
    stop_reason: openaiFinishReasonToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: (payload.usage && payload.usage.prompt_tokens) || 0,
      output_tokens: (payload.usage && payload.usage.completion_tokens) || 0,
    },
  };
}

function anthropicErrorPayload(statusCode, payload) {
  let message;
  if (payload && typeof payload === "object") {
    message =
      (payload.error && payload.error.message) || payload.message || JSON.stringify(payload);
  } else {
    message = String(payload || `upstream ${statusCode}`);
  }
  return {
    type: "error",
    error: {
      type: statusCode === 401 ? "authentication_error" : "api_error",
      message,
    },
  };
}

// Char-based heuristic — matches the spirit of the Python reference. Good
// enough for Claude Code's pre-flight check; real tokenization not required.
function countTokensEstimate(payload) {
  let total = 0;
  if (payload.system) total += estimateTokensFromText(anthropicSystemToText(payload.system));
  for (const m of payload.messages || []) {
    total += estimateContentTokens(m.content);
  }
  for (const t of payload.tools || []) {
    total += estimateTokensFromText(t.name || "");
    total += estimateTokensFromText(t.description || "");
    if (t.input_schema) total += estimateTokensFromText(JSON.stringify(t.input_schema));
  }
  return total;
}

function estimateContentTokens(content) {
  if (content == null) return 0;
  if (typeof content === "string") return estimateTokensFromText(content);
  if (!Array.isArray(content)) return estimateTokensFromText(flattenContentToText(content));
  let total = 0;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text") total += estimateTokensFromText(item.text || "");
    else if (item.type === "tool_use") total += estimateTokensFromText(JSON.stringify(item.input || {}));
    else if (item.type === "tool_result") total += estimateTokensFromText(flattenContentToText(item.content));
    else if (item.type === "image") total += 258; // Anthropic baseline
  }
  return total;
}

function estimateTokensFromText(text) {
  if (!text) return 0;
  // Very rough: 1 token ≈ 4 chars, but min 1 per non-empty string.
  return Math.max(1, Math.ceil(text.length / 4));
}

// ---------- Stream: OpenAI SSE → Anthropic SSE ---------------------------

async function* anthropicStreamFromOpenAI(openaiPayloadIter, requestedModel) {
  let textBlockIndex = null;
  let finishReason = null;
  let usage = {};
  let nextBlockIndex = 0;
  const toolStates = new Map(); // upstreamIndex → { callId, name, started, blockIndex, bufferedArgParts[] }
  let started = false;
  const messageId = newId("msg");

  try {
    for await (const payload of openaiPayloadIter) {
      if (!started) {
        started = true;
        yield formatNamedSSE("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: requestedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
      }

      const choice = (payload.choices && payload.choices[0]) || {};
      const delta = choice.delta || {};
      if (payload.usage) usage = payload.usage;
      if (choice.finish_reason) finishReason = openaiFinishReasonToAnthropic(choice.finish_reason);

      // Text deltas
      if (typeof delta.content === "string" && delta.content) {
        if (textBlockIndex === null) {
          textBlockIndex = nextBlockIndex++;
          yield formatNamedSSE("content_block_start", {
            type: "content_block_start",
            index: textBlockIndex,
            content_block: { type: "text", text: "" },
          });
        }
        yield formatNamedSSE("content_block_delta", {
          type: "content_block_delta",
          index: textBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      // Tool-call deltas
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const upstreamIndex = Number(tc.index || 0);
          let state = toolStates.get(upstreamIndex);
          if (!state) {
            state = {
              callId: null,
              name: null,
              started: false,
              blockIndex: null,
              bufferedArgParts: [],
            };
            toolStates.set(upstreamIndex, state);
          }
          if (tc.id) state.callId = tc.id;
          const fn = tc.function || {};
          if (fn.name) state.name = fn.name;
          const argDelta = fn.arguments || "";

          // If name isn't known yet, buffer argument chunks until it arrives.
          if (!state.started && !state.name && argDelta) {
            state.bufferedArgParts.push(argDelta);
            continue;
          }
          // Start the block when we have a name.
          if (!state.started && state.name) {
            state.started = true;
            state.blockIndex = nextBlockIndex++;
            yield formatNamedSSE("content_block_start", {
              type: "content_block_start",
              index: state.blockIndex,
              content_block: {
                type: "tool_use",
                id: state.callId || newId("call"),
                name: state.name,
                input: {},
              },
            });
            // Flush buffered argument parts now that the block has started.
            for (const buffered of state.bufferedArgParts) {
              yield formatNamedSSE("content_block_delta", {
                type: "content_block_delta",
                index: state.blockIndex,
                delta: { type: "input_json_delta", partial_json: buffered },
              });
            }
            state.bufferedArgParts.length = 0;
          }
          if (state.started && argDelta) {
            yield formatNamedSSE("content_block_delta", {
              type: "content_block_delta",
              index: state.blockIndex,
              delta: { type: "input_json_delta", partial_json: argDelta },
            });
          }
        }
      }
    }

    if (!started) {
      // Empty upstream response — emit a minimal start frame so the client
      // still gets a well-formed SSE stream.
      yield formatNamedSSE("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: [],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }

    // Close every block we actually started, in index order.
    const startedBlocks = [];
    if (textBlockIndex !== null) startedBlocks.push(textBlockIndex);
    for (const state of toolStates.values()) {
      if (state.started && state.blockIndex !== null) startedBlocks.push(state.blockIndex);
    }
    startedBlocks.sort((a, b) => a - b);
    for (const idx of startedBlocks) {
      yield formatNamedSSE("content_block_stop", { type: "content_block_stop", index: idx });
    }

    yield formatNamedSSE("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: finishReason || "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: Number(usage.completion_tokens || 0) },
    });
    yield formatNamedSSE("message_stop", { type: "message_stop" });
  } catch (e) {
    // Emit an Anthropic-style error frame so clients get a useful message.
    yield formatNamedSSE("error", {
      type: "error",
      error: { type: "api_error", message: e instanceof Error ? e.message : String(e) },
    });
  }
}

module.exports = {
  ANTHROPIC_VERSION,
  anthropicRequestToOpenAI,
  openaiResponseToAnthropic,
  anthropicErrorPayload,
  countTokensEstimate,
  anthropicStreamFromOpenAI,
  // exposed for tests
  anthropicSystemToText,
  anthropicUserContentToOpenAIMessages,
  anthropicAssistantContentToOpenAIMessage,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  resolveAnthropicModel,
  openaiFinishReasonToAnthropic,
};
