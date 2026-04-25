"use strict";

// OpenAI Responses <-> OpenAI chat.completions translator.
//
// Scope: text + function-tool calls + image input, with `previous_response_id`
// history stitched from an in-memory LRU+TTL store. Enough to let Codex CLI
// talk to ToCodex.

const { flattenContentToText, normalizeOpenAIContent } = require("./openai-schema");
const { newId } = require("./util");
const { formatOpenAISSE } = require("./sse");

// ---------- Session store -----------------------------------------------

class SessionStore {
  constructor({ ttlMs = 30 * 60 * 1000, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.m = new Map(); // id → { at, history }
  }
  get(id) {
    if (!id) return undefined;
    const entry = this.m.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.m.delete(id);
      return undefined;
    }
    // refresh LRU order
    this.m.delete(id);
    this.m.set(id, entry);
    return entry.history;
  }
  put(id, history) {
    if (!id) return;
    if (this.m.has(id)) this.m.delete(id);
    this.m.set(id, { at: Date.now(), history });
    while (this.m.size > this.max) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }
}

// ---------- Request: Responses → OpenAI ----------------------------------

// Translate a single Responses input-item into zero-or-more OpenAI messages.
function responsesItemToOpenAIMessages(item) {
  if (!item || typeof item !== "object") return [];
  const type = item.type || "message";
  if (type === "message") {
    const role = item.role || "user";
    const content = normalizeOpenAIContent(item.content);
    const msg = { role };
    if (content !== null && content !== undefined) msg.content = content;
    else msg.content = "";
    return [msg];
  }
  if (type === "function_call") {
    // Assistant-side tool call issued in a previous turn.
    return [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id || item.id || newId("call"),
            type: "function",
            function: {
              name: item.name || "",
              arguments:
                typeof item.arguments === "string"
                  ? item.arguments
                  : JSON.stringify(item.arguments ?? {}),
            },
          },
        ],
      },
    ];
  }
  if (type === "function_call_output") {
    return [
      {
        role: "tool",
        tool_call_id: item.call_id || "",
        content: flattenContentToText(item.output),
      },
    ];
  }
  // ignore reasoning/computer_use/etc for now
  return [];
}

function responsesTopLevelInputToMessages(input) {
  if (input == null) return [];
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) messages.push(...responsesItemToOpenAIMessages(item));
  return messages;
}

function responsesToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    if (t.type !== "function") continue; // only function tools supported
    out.push({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || { type: "object", properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

function responsesToolChoiceToOpenAI(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice; // "auto"|"none"|"required"
  if (typeof choice === "object") {
    if (choice.type === "function" && choice.name) {
      return { type: "function", function: { name: choice.name } };
    }
    if (choice.type === "auto" || choice.type === "none" || choice.type === "required") {
      return choice.type;
    }
  }
  return undefined;
}

function responsesRequestToOpenAI(payload, history, { defaultModel } = {}) {
  const messages = [];

  if (payload.instructions) {
    const sysText =
      typeof payload.instructions === "string"
        ? payload.instructions
        : flattenContentToText(payload.instructions);
    if (sysText) messages.push({ role: "system", content: sysText });
  }

  if (Array.isArray(history) && history.length) {
    for (const m of history) messages.push(m);
  }

  messages.push(...responsesTopLevelInputToMessages(payload.input));

  const out = {
    messages,
    model: payload.model || defaultModel,
    stream: !!payload.stream,
  };
  if (!out.model) {
    const err = new Error("missing model (set TOCODEX_DEFAULT_MODEL or pass `model`)");
    err.statusCode = 400;
    throw err;
  }
  if (typeof payload.max_output_tokens === "number") out.max_tokens = payload.max_output_tokens;
  if (typeof payload.temperature === "number") out.temperature = payload.temperature;
  if (typeof payload.top_p === "number") out.top_p = payload.top_p;

  const tools = responsesToolsToOpenAI(payload.tools);
  if (tools) out.tools = tools;
  const choice = responsesToolChoiceToOpenAI(payload.tool_choice);
  if (choice !== undefined) out.tool_choice = choice;

  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

// ---------- Response: OpenAI → Responses ---------------------------------

function openaiFinishReasonToResponsesStatus(reason) {
  if (reason === "stop") return "completed";
  if (reason === "length") return "incomplete";
  if (reason === "tool_calls" || reason === "function_call") return "completed";
  return "completed";
}

function assistantMessageFromOpenaiChoice(choice) {
  // Preserve a chat.completions-style assistant message for history replay.
  const msg = choice.message || {};
  const out = { role: "assistant", content: typeof msg.content === "string" ? msg.content : "" };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) out.tool_calls = msg.tool_calls;
  return out;
}

function openaiResponseToResponses(payload, requestedModel) {
  const choice = (payload.choices && payload.choices[0]) || {};
  const msg = choice.message || {};
  const output = [];

  const text = typeof msg.content === "string" ? msg.content : "";
  if (text) {
    output.push({
      type: "message",
      id: newId("msg"),
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const fn = tc.function || {};
      output.push({
        type: "function_call",
        id: tc.id || newId("call"),
        call_id: tc.id || newId("call"),
        name: fn.name || "",
        arguments: fn.arguments || "",
        status: "completed",
      });
    }
  }

  const responseId = payload.id ? `resp_${payload.id}` : newId("resp");
  return {
    id: responseId,
    object: "response",
    created_at: payload.created || Math.floor(Date.now() / 1000),
    status: openaiFinishReasonToResponsesStatus(choice.finish_reason),
    model: requestedModel || payload.model || "",
    output,
    usage: responsesUsageFromOpenAI(payload.usage),
  };
}

function responsesUsageFromOpenAI(usage) {
  const inputTokens = Number((usage && (usage.prompt_tokens ?? usage.input_tokens)) || 0);
  const outputTokens = Number((usage && (usage.completion_tokens ?? usage.output_tokens)) || 0);
  const totalTokens = Number((usage && usage.total_tokens) ?? inputTokens + outputTokens);
  const cachedTokens = Number(
    (usage &&
      (usage.prompt_tokens_details?.cached_tokens ??
        usage.input_tokens_details?.cached_tokens)) ||
      0
  );
  const reasoningTokens = Number(
    (usage &&
      (usage.completion_tokens_details?.reasoning_tokens ??
        usage.output_tokens_details?.reasoning_tokens)) ||
      0
  );

  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: totalTokens,
  };
}

// ---------- Stream: OpenAI SSE → Responses SSE ---------------------------

async function* responsesStreamFromOpenAI(openaiPayloadIter, requestedModel, responseId) {
  // We emit a close approximation of Codex-observed Responses SSE events:
  //   response.created                (once, up front)
  //   response.output_item.added      (per text/function item)
  //   response.output_text.delta      (per content chunk)
  //   response.function_call_arguments.delta
  //   response.output_item.done       (per item)
  //   response.completed              (final)

  let textItemIndex = null;
  let textItemId = null;
  const toolStates = new Map(); // upstreamIndex → { itemId, name, callId, started }
  let finishReason = null;
  let usage = {};
  let outputIndex = 0;
  let assistantTextChunks = [];
  let assistantToolCalls = [];

  yield formatOpenAISSE({
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: requestedModel,
      status: "in_progress",
      output: [],
    },
  });

  try {
    for await (const payload of openaiPayloadIter) {
      const choice = (payload.choices && payload.choices[0]) || {};
      const delta = choice.delta || {};
      if (payload.usage) usage = payload.usage;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      if (typeof delta.content === "string" && delta.content) {
        if (textItemIndex === null) {
          textItemIndex = outputIndex++;
          textItemId = newId("msg");
          yield formatOpenAISSE({
            type: "response.output_item.added",
            output_index: textItemIndex,
            item: {
              type: "message",
              id: textItemId,
              role: "assistant",
              content: [{ type: "output_text", text: "" }],
            },
          });
        }
        assistantTextChunks.push(delta.content);
        yield formatOpenAISSE({
          type: "response.output_text.delta",
          item_id: textItemId,
          output_index: textItemIndex,
          content_index: 0,
          delta: delta.content,
        });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const upstreamIndex = Number(tc.index || 0);
          let state = toolStates.get(upstreamIndex);
          if (!state) {
            state = {
              itemId: null,
              outputIndex: null,
              name: null,
              callId: null,
              started: false,
              argBuffer: [],
            };
            toolStates.set(upstreamIndex, state);
          }
          if (tc.id) state.callId = tc.id;
          const fn = tc.function || {};
          if (fn.name) state.name = fn.name;
          const argDelta = fn.arguments || "";
          if (!state.started && state.name) {
            state.started = true;
            state.itemId = newId("fc");
            state.outputIndex = outputIndex++;
            yield formatOpenAISSE({
              type: "response.output_item.added",
              output_index: state.outputIndex,
              item: {
                type: "function_call",
                id: state.itemId,
                call_id: state.callId || newId("call"),
                name: state.name,
                arguments: "",
                status: "in_progress",
              },
            });
            for (const buffered of state.argBuffer) {
              yield formatOpenAISSE({
                type: "response.function_call_arguments.delta",
                item_id: state.itemId,
                output_index: state.outputIndex,
                delta: buffered,
              });
            }
            state.argBuffer.length = 0;
          }
          if (argDelta) {
            if (!state.started) state.argBuffer.push(argDelta);
            else
              yield formatOpenAISSE({
                type: "response.function_call_arguments.delta",
                item_id: state.itemId,
                output_index: state.outputIndex,
                delta: argDelta,
              });
            if (state.started) {
              state._fullArgs = (state._fullArgs || "") + argDelta;
            } else {
              state._fullArgs = (state._fullArgs || "") + argDelta;
            }
          }
        }
      }
    }

    // Close text item
    const finalOutput = [];
    if (textItemIndex !== null) {
      const text = assistantTextChunks.join("");
      yield formatOpenAISSE({
        type: "response.output_item.done",
        output_index: textItemIndex,
        item: {
          type: "message",
          id: textItemId,
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      });
      finalOutput.push({
        type: "message",
        id: textItemId,
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
    }
    // Close tool items
    for (const state of toolStates.values()) {
      if (!state.started) continue;
      const fullArgs = state._fullArgs || "";
      yield formatOpenAISSE({
        type: "response.output_item.done",
        output_index: state.outputIndex,
        item: {
          type: "function_call",
          id: state.itemId,
          call_id: state.callId || newId("call"),
          name: state.name,
          arguments: fullArgs,
          status: "completed",
        },
      });
      finalOutput.push({
        type: "function_call",
        id: state.itemId,
        call_id: state.callId || newId("call"),
        name: state.name,
        arguments: fullArgs,
        status: "completed",
      });
      assistantToolCalls.push({
        id: state.callId || state.itemId,
        type: "function",
        function: { name: state.name || "", arguments: fullArgs },
      });
    }

    yield formatOpenAISSE({
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: requestedModel,
        status: openaiFinishReasonToResponsesStatus(finishReason),
        output: finalOutput,
        usage: responsesUsageFromOpenAI(usage),
      },
    });

    return {
      assistantMessage: {
        role: "assistant",
        content: assistantTextChunks.join(""),
        ...(assistantToolCalls.length ? { tool_calls: assistantToolCalls } : {}),
      },
    };
  } catch (e) {
    yield formatOpenAISSE({
      type: "response.failed",
      response: {
        id: responseId,
        status: "failed",
        error: { message: e instanceof Error ? e.message : String(e) },
      },
    });
  }
}

module.exports = {
  SessionStore,
  responsesRequestToOpenAI,
  openaiResponseToResponses,
  responsesStreamFromOpenAI,
  assistantMessageFromOpenaiChoice,
  responsesUsageFromOpenAI,
  // test exports
  responsesItemToOpenAIMessages,
  responsesTopLevelInputToMessages,
  responsesToolsToOpenAI,
  responsesToolChoiceToOpenAI,
};
