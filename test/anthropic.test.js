"use strict";

const assert = require("node:assert/strict");
const {
  anthropicRequestToOpenAI,
  openaiResponseToAnthropic,
  anthropicStreamFromOpenAI,
  countTokensEstimate,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  selectAnthropicTargetModel,
} = require("../lib/anthropic");

(async () => {

// 1. Text-only request translation.
{
  const out = anthropicRequestToOpenAI({
    model: "gpt-4o-mini",
    system: "you are helpful",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 128,
    stream: true,
  });
  assert.equal(out.model, "gpt-4o-mini");
  assert.equal(out.stream, true);
  assert.deepEqual(out.stream_options, { include_usage: true });
  assert.equal(out.max_tokens, 128);
  assert.deepEqual(out.messages[0], { role: "system", content: "you are helpful" });
  assert.deepEqual(out.messages[1], { role: "user", content: "hi" });
}

// 2. Image input (base64) → OpenAI image_url data URI.
{
  const out = anthropicRequestToOpenAI({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAA" },
          },
        ],
      },
    ],
  });
  const user = out.messages[0];
  assert.equal(user.role, "user");
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content[0].type, "text");
  assert.equal(user.content[1].type, "image_url");
  assert.equal(user.content[1].image_url.url, "data:image/png;base64,AAA");
}

// 3. Assistant tool_use → OpenAI tool_calls, and user tool_result → role:"tool".
{
  const out = anthropicRequestToOpenAI({
    model: "gpt-4o",
    messages: [
      { role: "user", content: "call get_weather for Beijing" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_weather",
            input: { city: "Beijing" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "sunny, 24C" }],
          },
        ],
      },
    ],
  });

  assert.equal(out.messages[1].role, "assistant");
  assert.equal(out.messages[1].content, "ok");
  assert.deepEqual(out.messages[1].tool_calls, [
    {
      id: "toolu_1",
      type: "function",
      function: { name: "get_weather", arguments: JSON.stringify({ city: "Beijing" }) },
    },
  ]);

  const toolMsg = out.messages[2];
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.tool_call_id, "toolu_1");
  assert.equal(toolMsg.content, "sunny, 24C");
}

// 4. Tools schema translation.
{
  const tools = anthropicToolsToOpenAI([
    {
      name: "get_weather",
      description: "gets weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    },
  ]);
  assert.deepEqual(tools, [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "gets weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ]);
  assert.equal(anthropicToolChoiceToOpenAI("any"), "auto");
  assert.deepEqual(anthropicToolChoiceToOpenAI({ type: "tool", name: "x" }), {
    type: "function",
    function: { name: "x" },
  });
}

// 5. Non-stream response: text + tool_use reassembly.
{
  const anth = openaiResponseToAnthropic(
    {
      id: "chatcmpl-1",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "let me check",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Beijing"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    "gpt-4o"
  );
  assert.equal(anth.stop_reason, "tool_use");
  assert.equal(anth.content[0].type, "text");
  assert.equal(anth.content[0].text, "let me check");
  assert.equal(anth.content[1].type, "tool_use");
  assert.deepEqual(anth.content[1].input, { city: "Beijing" });
  assert.equal(anth.usage.input_tokens, 10);
  assert.equal(anth.usage.output_tokens, 5);
}

// 6. Stream translator emits message_start/content_block_* in order.
{
  async function* fakeOpenAI() {
    yield { choices: [{ delta: { content: "he" } }] };
    yield { choices: [{ delta: { content: "llo" } }] };
    yield {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "get_weather", arguments: '{"city"' },
              },
            ],
          },
        },
      ],
    };
    yield {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: ':"Beijing"}' } }],
          },
        },
      ],
    };
    yield { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { completion_tokens: 7 } };
  }
  const frames = [];
  for await (const chunk of anthropicStreamFromOpenAI(fakeOpenAI(), "gpt-4o")) {
    frames.push(chunk.toString("utf8"));
  }
  const joined = frames.join("");
  assert.ok(joined.startsWith("event: message_start\n"));
  assert.ok(joined.includes('"type":"content_block_start"'));
  assert.ok(joined.includes('"type":"text_delta","text":"he"'));
  assert.ok(joined.includes('"type":"text_delta","text":"llo"'));
  assert.ok(joined.includes('"type":"tool_use"'));
  assert.ok(joined.includes('"partial_json":"{\\"city\\""'));
  assert.ok(joined.includes('"partial_json":":\\"Beijing\\"}"'));
  assert.ok(joined.includes('"stop_reason":"tool_use"'));
  assert.ok(joined.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
}

// 7. count_tokens stays reasonable.
{
  const t = countTokensEstimate({
    system: "you are helpful",
    messages: [{ role: "user", content: "hello world" }],
  });
  assert.ok(t > 0 && t < 20);
}

// 8. Claude model ids can be replaced with the ToCodex/OpenAI target model.
{
  assert.equal(
    selectAnthropicTargetModel("claude-sonnet-4-5-20250929", "gpt-4o-mini"),
    "gpt-4o-mini"
  );
  assert.equal(selectAnthropicTargetModel("gpt-4o", "gpt-4o-mini"), "gpt-4o");
}

console.log("anthropic.test.js: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
