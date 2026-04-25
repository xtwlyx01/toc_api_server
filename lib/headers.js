"use strict";

// Single source of truth for outbound-to-ToCodex request headers.
//
// Anything sent to the upstream MUST be authored here.  The relay never
// forwards client-origin headers — impersonation of the VSCode extension
// (v3.1.3) requires a byte-exact whitelist.
//
// The whitelist was verified by reverse-engineering the real extension
// (`dist/extension.js`).  The extension does NOT use one uniform header
// set for all requests; four distinct code paths emit four different
// fingerprints against api.tocodex.com:
//
//   (1) /v1/chat/completions for ordinary chat
//       → OpenAI Node SDK v5.12.2, `defaultHeaders: Fd`
//         Fd = {HTTP-Referer: https://github.com/tocodex/ToCodex,
//               X-Title: ToCodex, User-Agent: ToCodex/3.1.3}
//         plus the SDK auto-injects all X-Stainless-* headers and the
//         handler layers its own X-Roo-App-Version / optional X-Roo-Task-ID.
//         Accept-Encoding is `identity` (the SDK sets this).
//         SIGNED.
//
//   (2) /v1/chat/completions for image generation fallback  (lUe())
//       → native `fetch()` (undici) with
//         {Authorization, Content-Type, HTTP-Referer: https://tocodex.com,
//          X-Title: ToCodex, ...extraHeaders=sig}
//         (note the DIFFERENT Referer and that there is NO Stainless,
//         NO X-Roo-App-Version, NO explicit User-Agent — undici adds
//         User-Agent: node, accept: */*, accept-language: *,
//         sec-fetch-mode: cors, accept-encoding: gzip, deflate).
//         Body contains `modalities: ["image","text"]`.
//         SIGNED.
//
//   (3) /v1/images/generations                             (ici())
//       → native fetch, same shape as (2) but against the images
//         endpoint.  SIGNED.
//
//   (4) /v1/models  and other auxiliary endpoints          (r6o())
//       → native fetch with {Fd..., Authorization}.  So this one DOES
//         set User-Agent to ToCodex/3.1.3 and Referer to github, but it
//         inherits the undici default tail (accept, accept-language,
//         sec-fetch-mode, user-agent is overridden by Fd but accept/etc
//         remain).  NOT SIGNED.
//
// The `profile` argument picks which of these flavors to emit.

const { signToCodex } = require("./sign");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// OpenAI SDK bundled inside the extension (K3 constant in dist/extension.js).
const OPENAI_SDK_VERSION = "5.12.2";

// Plausible VSCode Electron host defaults, chosen constant so the relay
// does not leak the host machine's real environment.
const STAINLESS_STATIC = {
  lang: "js",
  os: "Windows",
  arch: "x64",
  runtime: "node",
  runtimeVersion: "v20.15.0",
  timeoutSeconds: 600,
};

// undici (Node's global fetch) appends these on every request unless
// the caller sets them explicitly.  We emit them on profiles that the
// real extension drives through `fetch()` so the wire bytes match.
const UNDICI_TAIL = {
  accept: "*/*",
  "accept-language": "*",
  "sec-fetch-mode": "cors",
  "user-agent": "node",
  "accept-encoding": "gzip, deflate",
};

const IMAGES_REFERER = "https://tocodex.com";

// Pick a profile based on the upstream path plus an optional body hint.
// Chat completion bodies with `modalities` are the image-fallback path
// and must use the images-flavored header set even though they land on
// /v1/chat/completions.
function pickProfile(path, bodyHint) {
  if (path === "/v1/chat/completions") {
    if (bodyHint && Array.isArray(bodyHint.modalities) && bodyHint.modalities.length > 0)
      return "images-chat";
    return "sdk";
  }
  if (path === "/v1/images/generations") return "images";
  return "lean";
}

function buildUpstreamHeaders(
  config,
  {
    path,
    method = "POST",
    apiKey,
    taskId,
    stream = false,
    hasBody = false,
    contentLength,
    retryCount = 0,
    profile, // explicit override
    bodyHint, // used by pickProfile when profile is not supplied
  } = {}
) {
  if (!path) throw new Error("buildUpstreamHeaders: path is required");
  const prof = profile || pickProfile(path, bodyHint);
  const headers = {};

  // ---- undici prepends these two before everything else --------------------
  // The Node http layer always prepends Host + Connection, so we author them
  // here so the real order upstream sees matches.
  headers["Host"] = config.apiUrl.host;
  headers["Connection"] = "keep-alive";

  // ---- caller-explicit headers that every profile emits --------------------
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (hasBody) headers["Content-Type"] = "application/json";

  if (prof === "sdk") {
    // OpenAI SDK sets Accept explicitly and uses identity for encoding.
    headers["Accept"] = stream ? "text/event-stream" : "application/json";
    headers["Accept-Encoding"] = "identity";
    headers["User-Agent"] = `ToCodex/${config.appVersion}`;
    headers["HTTP-Referer"] = config.referer;
    headers["X-Title"] = config.title;

    // OpenAI SDK v5.12.2 auto-injected fingerprint
    headers["X-Stainless-Retry-Count"] = String(retryCount);
    headers["X-Stainless-Timeout"] = String(STAINLESS_STATIC.timeoutSeconds);
    headers["X-Stainless-Lang"] = STAINLESS_STATIC.lang;
    headers["X-Stainless-Package-Version"] = OPENAI_SDK_VERSION;
    headers["X-Stainless-OS"] = STAINLESS_STATIC.os;
    headers["X-Stainless-Arch"] = STAINLESS_STATIC.arch;
    headers["X-Stainless-Runtime"] = STAINLESS_STATIC.runtime;
    headers["X-Stainless-Runtime-Version"] = STAINLESS_STATIC.runtimeVersion;

    // ToCodex-specific user-agent decorations (only emitted on the SDK path)
    headers["X-Roo-App-Version"] = config.appVersion;
    if (taskId && typeof taskId === "string" && UUID_RE.test(taskId)) {
      headers["X-Roo-Task-ID"] = taskId;
    }
  } else if (prof === "lean") {
    // r6o(): explicit Fd branding but driven by raw fetch() → undici
    // appends accept / accept-language / sec-fetch-mode / accept-encoding.
    // User-Agent: the explicit Fd.User-Agent wins over undici's default.
    headers["User-Agent"] = `ToCodex/${config.appVersion}`;
    headers["HTTP-Referer"] = config.referer;
    headers["X-Title"] = config.title;
  } else if (prof === "images" || prof === "images-chat") {
    // lUe() / ici(): no explicit User-Agent → undici supplies "node".
    // Different Referer from Fd.
    headers["HTTP-Referer"] = IMAGES_REFERER;
    headers["X-Title"] = config.title;
  }

  // ---- signing (if applicable) --------------------------------------------
  if (config.signAllPaths || config.signedPaths.has(path)) {
    const { timestamp, nonce, signature } = signToCodex({
      method,
      path,
      secret: config.hmacSecret,
    });
    headers["X-ToCodex-Timestamp"] = timestamp;
    headers["X-ToCodex-Nonce"] = nonce;
    headers["X-ToCodex-Sig"] = signature;
  }

  // ---- undici tail (profiles driven by native fetch) ----------------------
  if (prof === "lean" || prof === "images" || prof === "images-chat") {
    // undici order: accept, accept-language, sec-fetch-mode, user-agent,
    // accept-encoding.  If the caller already set User-Agent (lean does),
    // undici keeps the caller's version.
    headers["accept"] = UNDICI_TAIL.accept;
    headers["accept-language"] = UNDICI_TAIL["accept-language"];
    headers["sec-fetch-mode"] = UNDICI_TAIL["sec-fetch-mode"];
    if (!headers["User-Agent"]) headers["user-agent"] = UNDICI_TAIL["user-agent"];
    headers["accept-encoding"] = UNDICI_TAIL["accept-encoding"];
  }

  if (hasBody && contentLength != null) {
    headers["Content-Length"] = String(contentLength);
  }

  return headers;
}

module.exports = {
  buildUpstreamHeaders,
  pickProfile,
  UUID_RE,
  OPENAI_SDK_VERSION,
  STAINLESS_STATIC,
  UNDICI_TAIL,
  IMAGES_REFERER,
};