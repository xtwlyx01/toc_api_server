"use strict";

// Tests for lib/headers.js — the whitelist-only outbound header builder.
// Run with `node test/headers.test.js`.

const assert = require("node:assert/strict");
const { loadConfig, DEFAULT_APP_VERSION } = require("../lib/sign");
const { buildUpstreamHeaders, pickProfile, IMAGES_REFERER } = require("../lib/headers");

const FORBIDDEN_KEYS = [
  "anthropic-version",
  "anthropic-beta",
  "x-api-key",
];

function lowerKeys(h) {
  return Object.keys(h).map((k) => k.toLowerCase());
}

function assertNoForbidden(h) {
  const lowered = lowerKeys(h);
  for (const k of FORBIDDEN_KEYS) {
    assert.ok(!lowered.includes(k), `forbidden header leaked: ${k}`);
  }
}

const CFG = loadConfig({ TOCODEX_API_URL: "https://api.tocodex.com" });

// Case A: "sdk" profile — chat completions, streaming, UUID taskId.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    taskId: "11111111-1111-1111-1111-111111111111",
    stream: true,
    hasBody: true,
    contentLength: 42,
  });
  // No undici tail headers here — the SDK manages its own Accept/Encoding.
  for (const k of Object.keys(h)) {
    assert.ok(k !== "accept", `sdk profile must NOT emit lowercase accept`);
    assert.ok(k !== "accept-language");
    assert.ok(k !== "sec-fetch-mode");
  }
  assert.equal(h["Accept"], "text/event-stream");
  assert.equal(h["Accept-Encoding"], "identity");
  assert.equal(h["User-Agent"], `ToCodex/${DEFAULT_APP_VERSION}`);
  assert.equal(h["HTTP-Referer"], "https://github.com/tocodex/ToCodex");
  assert.equal(h["X-Stainless-Package-Version"], "5.12.2");
  assert.equal(h["X-Roo-Task-ID"], "11111111-1111-1111-1111-111111111111");
  assert.match(h["X-ToCodex-Sig"], /^[0-9a-f]{64}$/u);
  assertNoForbidden(h);
}

// Case B: "images" profile — /v1/images/generations.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/images/generations",
    method: "POST",
    apiKey: "sk",
    hasBody: true,
    contentLength: 20,
  });
  assert.equal(h["HTTP-Referer"], IMAGES_REFERER, "images Referer must be https://tocodex.com");
  assert.equal(h["X-Title"], "ToCodex");
  assert.ok(!("User-Agent" in h), "images profile must not set explicit User-Agent");
  for (const k of Object.keys(h)) {
    assert.ok(!k.toLowerCase().startsWith("x-stainless-"));
    assert.ok(!k.toLowerCase().startsWith("x-roo-"));
  }
  // undici tail present
  assert.equal(h["accept"], "*/*");
  assert.equal(h["accept-language"], "*");
  assert.equal(h["sec-fetch-mode"], "cors");
  assert.equal(h["user-agent"], "node");
  assert.equal(h["accept-encoding"], "gzip, deflate");
  // signed
  assert.match(h["X-ToCodex-Sig"], /^[0-9a-f]{64}$/u);
  assertNoForbidden(h);
}

// Case C: "images-chat" profile — /v1/chat/completions with modalities.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    hasBody: true,
    contentLength: 100,
    bodyHint: { modalities: ["image", "text"] },
  });
  assert.equal(h["HTTP-Referer"], IMAGES_REFERER, "images-chat Referer must be https://tocodex.com");
  assert.ok(!("User-Agent" in h), "images-chat profile must not set explicit User-Agent");
  for (const k of Object.keys(h)) {
    assert.ok(!k.toLowerCase().startsWith("x-stainless-"));
    assert.ok(!k.toLowerCase().startsWith("x-roo-"));
  }
  assert.equal(h["accept"], "*/*");
  assert.equal(h["accept-encoding"], "gzip, deflate");
  assert.match(h["X-ToCodex-Sig"], /^[0-9a-f]{64}$/u); // still signed
}

// Case D: "lean" profile — /v1/models.  Has Fd branding + undici tail.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/models",
    method: "GET",
    apiKey: "sk",
  });
  // Branding trio is explicit on this profile
  assert.equal(h["User-Agent"], `ToCodex/${DEFAULT_APP_VERSION}`);
  assert.equal(h["HTTP-Referer"], "https://github.com/tocodex/ToCodex");
  assert.equal(h["X-Title"], "ToCodex");
  // No signing, no Stainless, no Roo
  for (const k of Object.keys(h)) {
    assert.ok(!k.toLowerCase().startsWith("x-stainless-"));
    assert.ok(!k.toLowerCase().startsWith("x-roo-"));
    assert.ok(!k.toLowerCase().startsWith("x-tocodex-"));
  }
  // undici tail present
  assert.equal(h["accept"], "*/*");
  assert.equal(h["accept-language"], "*");
  assert.equal(h["sec-fetch-mode"], "cors");
  assert.equal(h["accept-encoding"], "gzip, deflate");
  // lean's explicit User-Agent must NOT be overwritten by undici tail
  assert.equal(h["User-Agent"], `ToCodex/${DEFAULT_APP_VERSION}`);
  assertNoForbidden(h);
}

// Case E: invalid task id dropped on sdk profile.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    taskId: "not-a-uuid",
    stream: false,
    hasBody: true,
    contentLength: 5,
  });
  assert.ok(!("X-Roo-Task-ID" in h));
}

// Case F: stream flag flips Accept on sdk profile only.
{
  const base = {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    hasBody: true,
    contentLength: 1,
  };
  assert.equal(
    buildUpstreamHeaders(CFG, { ...base, stream: true })["Accept"],
    "text/event-stream"
  );
  assert.equal(
    buildUpstreamHeaders(CFG, { ...base, stream: false })["Accept"],
    "application/json"
  );
}

// Case G: pickProfile with body hint.
{
  assert.equal(pickProfile("/v1/chat/completions"), "sdk");
  assert.equal(pickProfile("/v1/chat/completions", { modalities: ["image", "text"] }), "images-chat");
  assert.equal(pickProfile("/v1/chat/completions", { modalities: [] }), "sdk");
  assert.equal(pickProfile("/v1/images/generations"), "images");
  assert.equal(pickProfile("/v1/models"), "lean");
  assert.equal(pickProfile("/v1/something"), "lean");
}

// Case H: sign-all-paths mode signs even lean.
{
  const cfg = loadConfig({
    TOCODEX_API_URL: "https://api.tocodex.com",
    TOCODEX_SIGN_ALL_PATHS: "true",
  });
  const h = buildUpstreamHeaders(cfg, { path: "/v1/models", method: "GET", apiKey: "sk" });
  assert.ok("X-ToCodex-Sig" in h);
}

// Case I: explicit profile override.
{
  const h = buildUpstreamHeaders(CFG, {
    path: "/v1/chat/completions",
    method: "POST",
    apiKey: "sk",
    hasBody: true,
    contentLength: 1,
    profile: "lean",
  });
  assert.equal(h["User-Agent"], `ToCodex/${DEFAULT_APP_VERSION}`);
  assert.equal(h["accept"], "*/*");
  for (const k of Object.keys(h)) {
    assert.ok(!k.toLowerCase().startsWith("x-stainless-"));
  }
}

console.log("headers.test.js: all assertions passed");
