"use strict";

// ToCodex dynamic request-signing.
//
// Reverse-engineered from the ToCodex VSCode extension (publisher
// ToCodex.tocodex, v3.1.3):
//
//   payload = `${unix_seconds}:${uuid_nonce}:${METHOD}:${path}`
//   sig     = HMAC-SHA256(TOCODEX_HMAC_SECRET, payload).hex()
//
// Headers attached to the upstream request:
//   X-ToCodex-Timestamp: <unix_seconds>
//   X-ToCodex-Nonce:     <uuid>
//   X-ToCodex-Sig:       <hex>
//   X-Roo-App-Version:   <version>   (also used as User-Agent suffix)
//   HTTP-Referer, X-Title            (static branding headers)

const crypto = require("node:crypto");

const DEFAULT_HMAC_SECRET = "tc-hmac-s3cr3t-k3y-2026-tocodex-platform";
const DEFAULT_APP_VERSION = "3.1.3";
const DEFAULT_REFERER = "https://github.com/tocodex/ToCodex";
const DEFAULT_TITLE = "ToCodex";

function loadConfig(env = process.env) {
  const hmacSecret = env.TOCODEX_HMAC_SECRET || DEFAULT_HMAC_SECRET;
  const appVersion = env.TOCODEX_APP_VERSION || DEFAULT_APP_VERSION;
  const referer = env.TOCODEX_REFERER || DEFAULT_REFERER;
  const title = env.TOCODEX_TITLE || DEFAULT_TITLE;
  const apiUrl = normalizeApiUrl(env.TOCODEX_API_URL || "https://api.tocodex.com");

  const signAllPaths = (env.TOCODEX_SIGN_ALL_PATHS || "false").toLowerCase() === "true";
  const signedPaths = new Set(
    (env.TOCODEX_SIGNED_PATHS || "/v1/chat/completions,/v1/images/generations")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  );

  return {
    hmacSecret,
    appVersion,
    referer,
    title,
    apiUrl,
    signAllPaths,
    signedPaths,
    defaultApiKey: env.TOCODEX_API_KEY || "",
    defaultModel: env.TOCODEX_DEFAULT_MODEL || "",
  };
}

function normalizeApiUrl(value) {
  const url = new URL(value);
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/u, "");
  }
  // Strip a trailing /v1 if the user supplied one, so callers that pass a
  // path starting with /v1/... don't end up doubled.
  if (url.pathname === "/v1") url.pathname = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function signToCodex({ method, path, secret }) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const payload = `${timestamp}:${nonce}:${String(method).toUpperCase()}:${path}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return { timestamp, nonce, signature, payload };
}

// Build the baseline headers the ToCodex extension sends on every upstream
// request, optionally injecting a Bearer token when we have one.
function baseHeaders(config, { apiKey, taskId } = {}) {
  const h = {
    "HTTP-Referer": config.referer,
    "X-Title": config.title,
    "User-Agent": `ToCodex/${config.appVersion}`,
    "X-Roo-App-Version": config.appVersion,
  };
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  if (taskId) h["X-Roo-Task-ID"] = taskId;
  return h;
}

// Return the base headers plus the three dynamic signing headers.
function signedHeaders(config, { method = "POST", path, apiKey, taskId } = {}) {
  const h = baseHeaders(config, { apiKey, taskId });
  const { timestamp, nonce, signature } = signToCodex({
    method,
    path,
    secret: config.hmacSecret,
  });
  h["X-ToCodex-Timestamp"] = timestamp;
  h["X-ToCodex-Nonce"] = nonce;
  h["X-ToCodex-Sig"] = signature;
  return h;
}

// Resolve the full upstream URL for a given relative path like
// "/v1/chat/completions".
function upstreamUrl(config, path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return new URL(p.replace(/^\/+/u, ""), config.apiUrl);
}

module.exports = {
  DEFAULT_HMAC_SECRET,
  DEFAULT_APP_VERSION,
  loadConfig,
  normalizeApiUrl,
  signToCodex,
  baseHeaders,
  signedHeaders,
  upstreamUrl,
};
