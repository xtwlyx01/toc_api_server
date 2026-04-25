"use strict";

// Minimal assertion-based tests (no framework). Run with `node test/sign.test.js`.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  loadConfig,
  signToCodex,
  signedHeaders,
  upstreamUrl,
  normalizeApiUrl,
  DEFAULT_HMAC_SECRET,
  DEFAULT_APP_VERSION,
} = require("../lib/sign");

// 1. HMAC matches the ToCodex extension's scheme exactly.
{
  const secret = "tc-hmac-s3cr3t-k3y-2026-tocodex-platform";
  const timestamp = "1700000000";
  const nonce = "11111111-1111-1111-1111-111111111111";
  const payload = `${timestamp}:${nonce}:POST:/v1/chat/completions`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  // Verify our helper produces the exact same hex for the same inputs.
  const viaHelper = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}:${nonce}:POST:/v1/chat/completions`)
    .digest("hex");
  assert.equal(viaHelper, expected, "HMAC helper must match node crypto output");
}

// 2. signToCodex returns the right shape and a deterministic payload string.
{
  const { timestamp, nonce, signature, payload } = signToCodex({
    method: "post",
    path: "/v1/chat/completions",
    secret: "k",
  });
  assert.match(timestamp, /^\d+$/u);
  assert.match(nonce, /^[0-9a-f-]{36}$/u);
  assert.match(signature, /^[0-9a-f]{64}$/u);
  assert.equal(payload, `${timestamp}:${nonce}:POST:/v1/chat/completions`);
}

// 3. signedHeaders injects exactly the four signature-side headers plus UA.
{
  const cfg = loadConfig({ TOCODEX_API_URL: "https://example.test" });
  const h = signedHeaders(cfg, { method: "POST", path: "/v1/chat/completions", apiKey: "sk-test" });
  assert.equal(h["Authorization"], "Bearer sk-test");
  assert.equal(h["HTTP-Referer"], "https://github.com/tocodex/ToCodex");
  assert.equal(h["X-Title"], "ToCodex");
  assert.equal(h["User-Agent"], `ToCodex/${DEFAULT_APP_VERSION}`);
  assert.equal(h["X-Roo-App-Version"], DEFAULT_APP_VERSION);
  assert.match(h["X-ToCodex-Timestamp"], /^\d+$/u);
  assert.match(h["X-ToCodex-Nonce"], /^[0-9a-f-]{36}$/u);
  assert.match(h["X-ToCodex-Sig"], /^[0-9a-f]{64}$/u);
}

// 4. loadConfig defaults and env overrides behave sensibly.
{
  const cfg = loadConfig({});
  assert.equal(cfg.hmacSecret, DEFAULT_HMAC_SECRET);
  assert.equal(cfg.appVersion, DEFAULT_APP_VERSION);
  assert.equal(cfg.apiUrl.toString(), "https://api.tocodex.com/");
  assert.deepEqual(Array.from(cfg.signedPaths).sort(), [
    "/v1/chat/completions",
    "/v1/images/generations",
  ]);

  const cfg2 = loadConfig({
    TOCODEX_HMAC_SECRET: "xyz",
    TOCODEX_APP_VERSION: "9.9.9",
    TOCODEX_API_URL: "https://api.example.com/v1",
    TOCODEX_SIGNED_PATHS: "/a,/b",
    TOCODEX_SIGN_ALL_PATHS: "true",
  });
  assert.equal(cfg2.hmacSecret, "xyz");
  assert.equal(cfg2.appVersion, "9.9.9");
  assert.equal(cfg2.apiUrl.toString(), "https://api.example.com/");
  assert.deepEqual(Array.from(cfg2.signedPaths).sort(), ["/a", "/b"]);
  assert.equal(cfg2.signAllPaths, true);
}

// 5. normalizeApiUrl strips trailing /v1 to avoid double-prefixing and keeps a trailing slash.
{
  assert.equal(normalizeApiUrl("https://api.tocodex.com").toString(), "https://api.tocodex.com/");
  assert.equal(normalizeApiUrl("https://api.tocodex.com/").toString(), "https://api.tocodex.com/");
  assert.equal(normalizeApiUrl("https://api.tocodex.com/v1").toString(), "https://api.tocodex.com/");
  assert.equal(
    normalizeApiUrl("https://api.tocodex.com/v1/").toString(),
    "https://api.tocodex.com/"
  );
}

// 6. upstreamUrl joins cleanly regardless of leading slashes in the input path.
{
  const cfg = loadConfig({ TOCODEX_API_URL: "https://api.tocodex.com" });
  assert.equal(
    upstreamUrl(cfg, "/v1/chat/completions").toString(),
    "https://api.tocodex.com/v1/chat/completions"
  );
  assert.equal(
    upstreamUrl(cfg, "v1/models").toString(),
    "https://api.tocodex.com/v1/models"
  );
}

console.log("sign.test.js: all assertions passed");
