"use strict";

const assert = require("node:assert/strict");
const {
  SessionStore,
  responsesRequestToOpenAI,
  openaiResponseToResponses,
  responsesStreamFromOpenAI,
} = require("../lib/responses");

(async () => {

// 1. Plain text input + instructions.
{
  const out = responsesRequestToOpenAI(
    {
      model: "gpt-4o",
      instructions: "be concise",
      input: "hi",
    },
    undefined,
    {}
  );
  assert.deepEqual(out.messages, [
    { role: "system", content: "be concise" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(out.model, "gpt-4o");
}

// 2. previous_response_id history is prepended (between system and new input).
{
  const history = [
    { role: "user", content: "first" },
    { role: "assistant", content: "ack" },
  ];
  const out = responsesRequestToOpenAI(
    {
      model: "gpt-4o",
      instructions: "sys",
      input: "second",
    },
    history,
    {}
  );
  assert.deepEqual(out.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "first" },
    { role: "assistant", content: "ack" },
    { role: "user", content: "second" },
  ]);
}

// 3. function_call + function_call_output items replay as assistant tool_calls
//    + role:"tool" messages.
{
  const out = responsesRequestToOpenAI(
    {
      model: "gpt-4o",
      input: [
        { type: "message", role: "user", content: "what is the weather?" },
        {
          type: "function_call",
          call_id: "call_123",
          name: "get_weather",
          arguments: '{"city":"Beijing"}',
        },
        {
          type: "function_call_output",
          call_id: "call_123",
          output: "sunny",
        },
      ],
    },
    undefined,
    {}
  );
  assert.equal(out.messages[0].role, "user");
  assert.equal(out.messages[1].role, "assistant");
  assert.equal(out.messages[1].tool_calls[0].function.name, "get_weather");
  assert.equal(out.messages[2].role, "tool");
  assert.equal(out.messages[2].tool_call_id, "call_123");
  assert.equal(out.messages[2].content, "sunny");
}

// 4. Non-stream response wraps output items + usage.
{
  const wrapped = openaiResponseToResponses(
    {
      id: "chatcmpl-xyz",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "hi there",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "f", arguments: '{"a":1}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    },
    "gpt-4o"
  );
  assert.ok(wrapped.id.startsWith("resp_"));
  assert.equal(wrapped.status, "completed");
  assert.equal(wrapped.output[0].type, "message");
  assert.equal(wrapped.output[0].content[0].text, "hi there");
  assert.equal(wrapped.output[1].type, "function_call");
  assert.equal(wrapped.output[1].name, "f");
  assert.equal(wrapped.output[1].arguments, '{"a":1}');
  assert.equal(wrapped.usage.input_tokens, 11);
  assert.equal(wrapped.usage.output_tokens, 3);
  assert.equal(wrapped.usage.total_tokens, 14);
  assert.deepEqual(wrapped.usage.input_tokens_details, { cached_tokens: 0 });
  assert.deepEqual(wrapped.usage.output_tokens_details, { reasoning_tokens: 0 });
}

// 5. Stream emits response.created → deltas → response.completed.
{
  async function* fakeOpenAI() {
    yield { choices: [{ delta: { content: "he" } }] };
    yield { choices: [{ delta: { content: "llo" } }] };
    yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 2 } };
  }
  const frames = [];
  for await (const b of responsesStreamFromOpenAI(fakeOpenAI(), "gpt-4o", "resp_test")) {
    frames.push(b.toString("utf8"));
  }
  const joined = frames.join("");
  assert.ok(joined.includes('"type":"response.created"'));
  assert.ok(joined.includes('"type":"response.output_item.added"'));
  assert.ok(joined.includes('"type":"response.output_text.delta","item_id"'));
  assert.ok(joined.includes('"delta":"he"'));
  assert.ok(joined.includes('"delta":"llo"'));
  assert.ok(joined.includes('"type":"response.output_item.done"'));
  assert.ok(joined.includes('"type":"response.completed"'));
  assert.ok(joined.includes('"status":"completed"'));
  assert.ok(joined.includes('"total_tokens":2'));
}

// 6. SessionStore LRU + TTL.
{
  const s = new SessionStore({ ttlMs: 50, max: 2 });
  s.put("a", [{ role: "user", content: "1" }]);
  s.put("b", [{ role: "user", content: "2" }]);
  s.put("c", [{ role: "user", content: "3" }]); // evicts "a"
  assert.equal(s.get("a"), undefined);
  assert.ok(Array.isArray(s.get("b"))); // touching "b" makes it newest → "c" is now oldest
  s.put("d", [{ role: "user", content: "4" }]); // evicts "c"
  assert.equal(s.get("c"), undefined);
  assert.ok(Array.isArray(s.get("b")));
  assert.ok(Array.isArray(s.get("d")));
}

console.log("responses.test.js: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
