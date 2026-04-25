"use strict";

// Helpers for normalizing OpenAI chat-completions message payloads.
// These are used by both the Anthropic and Responses translators to produce
// consistent OpenAI-style bodies for the upstream ToCodex API.

// Flatten arbitrary content into plain text (used for tool_result bodies
// that must be collapsed into a `role:"tool"` message payload).
function flattenContentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const t = item.type;
      if (t === "text" || t === "input_text" || t === "output_text") {
        if (typeof item.text === "string") parts.push(item.text);
      } else if (t === "tool_result") {
        parts.push(flattenContentToText(item.content));
      } else if (t === "function_call_output") {
        parts.push(flattenContentToText(item.output));
      } else if (t === "image" || t === "input_image") {
        parts.push("[image]");
      } else if (t === "input_file" || t === "file") {
        parts.push(`[file:${item.filename || "unknown"}]`);
      }
    }
    return parts.filter(Boolean).join("\n");
  }
  if (typeof content === "object") return flattenContentToText(content.content);
  return String(content);
}

// Turn Anthropic/Responses content blocks into OpenAI-style content. May
// return a bare string (simple case), an array of mixed text/image_url
// parts, or null if the message carries no displayable content.
function normalizeOpenAIContent(content) {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return flattenContentToText(content);

  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const t = item.type;

    if (t === "text" || t === "input_text" || t === "output_text") {
      if (typeof item.text === "string") parts.push({ type: "text", text: item.text });
    } else if (t === "image" || t === "input_image") {
      const url = imageToDataUrl(item);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    } else if (t === "tool_result") {
      const txt = flattenContentToText(item.content);
      if (txt) parts.push({ type: "text", text: txt });
    } else if (t === "function_call_output") {
      const txt = flattenContentToText(item.output);
      if (txt) parts.push({ type: "text", text: txt });
    } else if (t === "input_file" || t === "file") {
      parts.push({ type: "text", text: `[file:${item.filename || "unknown"}]` });
    }
  }

  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function imageToDataUrl(item) {
  // Anthropic: { type:"image", source:{ type:"base64", media_type, data } }
  //        or: { type:"image", source:{ type:"url", url } }
  // Responses (OpenAI): { type:"input_image", image_url:"..." }
  //                     { type:"input_image", image_url:{ url:"..." } }
  if (item.image_url) {
    if (typeof item.image_url === "string") return item.image_url;
    if (typeof item.image_url === "object" && item.image_url.url) return item.image_url.url;
  }
  const src = item.source;
  if (src && typeof src === "object") {
    if (src.type === "base64") {
      const media = src.media_type || "image/png";
      const data = src.data || "";
      return `data:${media};base64,${data}`;
    }
    if (src.type === "url" && src.url) return src.url;
  }
  return null;
}

// Ensure a message object has an OpenAI-compatible shape. Returns a new object.
function normalizeOpenAIMessage(message) {
  const role = message.role || "user";
  const out = { role };
  const content = normalizeOpenAIContent(message.content);
  if (content !== null && content !== undefined) out.content = content;
  else out.content = "";

  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    out.tool_calls = message.tool_calls;
  }
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.name) out.name = message.name;
  return out;
}

module.exports = { flattenContentToText, normalizeOpenAIContent, normalizeOpenAIMessage };
