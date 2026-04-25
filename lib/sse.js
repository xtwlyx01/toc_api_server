"use strict";

// SSE parsing / formatting helpers. We consume upstream Server-Sent Events
// and re-emit them in client-specific formats.

// Parse an async iterable of Buffer/Uint8Array into a stream of decoded
// SSE "data:" JSON payloads. Handles multi-line events, "[DONE]" sentinels,
// and partial chunks split across TCP reads.
async function* parseOpenAISSE(byteIter) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of byteIter) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    // SSE events are separated by blank lines (\n\n or \r\n\r\n).
    while ((idx = findEventBoundary(buffer)) !== -1) {
      const raw = buffer.slice(0, idx.start);
      buffer = buffer.slice(idx.end);
      const evt = parseEventLines(raw);
      if (evt.data == null) continue;
      if (evt.data === "[DONE]") return;
      try {
        yield JSON.parse(evt.data);
      } catch {
        // ignore unparseable frames rather than kill the stream
      }
    }
  }
  // Flush any trailing event that wasn't terminated with a blank line.
  const tail = buffer + decoder.decode();
  if (tail.trim()) {
    const evt = parseEventLines(tail);
    if (evt.data && evt.data !== "[DONE]") {
      try {
        yield JSON.parse(evt.data);
      } catch {
        /* ignore */
      }
    }
  }
}

function findEventBoundary(buf) {
  const nn = buf.indexOf("\n\n");
  const rr = buf.indexOf("\r\n\r\n");
  if (nn === -1 && rr === -1) return -1;
  if (nn !== -1 && (rr === -1 || nn < rr)) {
    return { start: nn, end: nn + 2 };
  }
  return { start: rr, end: rr + 4 };
}

function parseEventLines(raw) {
  let data = null;
  let event = null;
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("data:")) {
      const chunk = line.slice(5).replace(/^ /u, "");
      data = data == null ? chunk : `${data}\n${chunk}`;
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
  }
  return { data, event };
}

// Format a named event for Anthropic-style SSE output.
// Anthropic clients key off `event: <name>` in addition to the JSON payload.
function formatNamedSSE(event, payload) {
  return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`, "utf8");
}

// Format a bare OpenAI-style SSE frame (`data: {...}\n\n`).
function formatOpenAISSE(payload) {
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, "utf8");
}

function formatDone() {
  return Buffer.from("data: [DONE]\n\n", "utf8");
}

module.exports = { parseOpenAISSE, formatNamedSSE, formatOpenAISSE, formatDone };
