"use strict";

// Tests for lib/normalize.js — the strict body allowlist.  Run with
// `node test/normalize.test.js`.

const assert = require("node:assert/strict");
const {
  normalizeChatBody,
  normalizeContent,
  normalizeMessage,
  normalizeTools,
  normalizeToolChoice,
  ROOT_ALLOW,
} = require("../lib/normalize");

// Minimal valid body passes through; root keys are within the allowlist.
{
  const out = normalizeChatBody({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(Object.keys(out).sort(), ["messages", "model"]);
  assert.equal(out.model, "x");
  assert.deepEqual(out.messages, [{ role: "user", content: "hi" }]);
}

// stream=true adds stream_options.
{
  const out = normalizeChatBody({
    model: "x",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.stream, true);
  assert.deepEqual(out.stream_options, { include_usage: true });
}

// Unknown root fields are dropped.
{
  const out = normalizeChatBody({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    parallel_tool_calls: true,
    response_format: { type: "json_object" },
    seed: 42,
    frequency_penalty: 0.1,
    presence_penalty: 0.1,
    logit_bias: { 13: -100 },
    top_p: 0.9,
    stop: ["foo"],
    n: 3,
    user: "u1",
    metadata: { a: 1 },
    store: true,
    extra_headers: { x: "y" },
    service_tier: "auto",
  });
  for (const k of Object.keys(out)) assert.ok(ROOT_ALLOW.has(k), `leaked: ${k}`);
  assert.equal(Object.keys(out).length, 2);
}

// Anthropic-style top-level `system` string is hoisted to messages[0].
{
  const out = normalizeChatBody({
    model: "x",
    system: "you are helpful",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "you are helpful");
  assert.equal(out.messages[1].role, "user");
  assert.ok(!("system" in out));
}

// Anthropic-style system array is joined.
{
  const out = normalizeChatBody({
    model: "x",
    system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.messages[0].content, "A\nB");
}

// Anthropic inline image is rewritten to OpenAI data URL.
{
  const out = normalizeChatBody({
    model: "x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
          },
        ],
      },
    ],
  });
  const parts = out.messages[0].content;
  assert.ok(Array.isArray(parts));
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, "data:image/jpeg;base64,AAAA");
}

// Message-level cache_control / unknown fields dropped.
{
  const msg = normalizeMessage({
    role: "user",
    content: "hi",
    cache_control: { type: "ephemeral" },
    foo: "bar",
  });
  assert.deepEqual(Object.keys(msg).sort(), ["content", "role"]);
}

// Tool-role carries tool_call_id.
{
  const msg = normalizeMessage({
    role: "tool",
    tool_call_id: "call_123",
    content: "42",
  });
  assert.equal(msg.tool_call_id, "call_123");
}

// Assistant tool_calls normalized — arguments stringified, unknown fields dropped.
{
  const msg = normalizeMessage({
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "search", arguments: { q: "hi" } },
        extra_field: "strip me",
      },
    ],
  });
  assert.equal(msg.tool_calls[0].id, "call_1");
  assert.equal(msg.tool_calls[0].function.arguments, '{"q":"hi"}');
  assert.ok(!("extra_field" in msg.tool_calls[0]));
}

// tools with non-function type are dropped.
{
  const out = normalizeTools([
    { type: "function", function: { name: "a", parameters: { type: "object" } } },
    { type: "code_interpreter" },
    { type: "function" }, // missing function object
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].function.name, "a");
}

// tool_choice literals and function object are both accepted.
{
  assert.equal(normalizeToolChoice("auto"), "auto");
  assert.equal(normalizeToolChoice("required"), "required");
  assert.deepEqual(normalizeToolChoice({ type: "function", function: { name: "x" } }), {
    type: "function",
    function: { name: "x" },
  });
  assert.equal(normalizeToolChoice("weird"), undefined);
}

// Missing model with no default → 400.
{
  assert.throws(() => normalizeChatBody({ messages: [{ role: "user", content: "hi" }] }), {
    statusCode: 400,
  });
}

// Empty messages after normalization → 400.
{
  assert.throws(
    () => normalizeChatBody({ model: "x", messages: [{ role: "unknown", content: "x" }] }),
    { statusCode: 400 }
  );
}

// Unknown message content part "thinking" contributes nothing when it has
// no .text, and does NOT break normalization.
{
  const out = normalizeChatBody({
    model: "x",
    messages: [
      {
        role: "user",
        content: [
          { type: "thinking", signature: "abc" },
          { type: "text", text: "hi" },
        ],
      },
    ],
  });
  assert.equal(out.messages[0].content, "hi");
}

// Content normalization is idempotent for plain strings.
{
  assert.equal(normalizeContent("hello"), "hello");
  assert.equal(normalizeContent(null), "");
  assert.equal(normalizeContent(undefined), "");
}

// max_output_tokens hoisted to max_tokens.
{
  const out = normalizeChatBody({
    model: "x",
    max_output_tokens: 256,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.max_tokens, 256);
  assert.ok(!("max_output_tokens" in out));
}

// Image-fallback chat body: modalities=["image","text"] preserved.
{
  const out = normalizeChatBody({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    modalities: ["image", "text"],
  });
  assert.deepEqual(out.modalities, ["image", "text"]);
}

// Unknown modality values stripped.
{
  const out = normalizeChatBody({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    modalities: ["image", "audio", "text", "video"],
  });
  assert.deepEqual(out.modalities, ["image", "text"]);
}

// Empty modalities array → field is absent, not empty array.
{
  const out = normalizeChatBody({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    modalities: [],
  });
  assert.ok(!("modalities" in out));
}

console.log("normalize.test.js: all assertions passed");
