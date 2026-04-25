"use strict";

// Minimal upstream HTTP client built directly on node:http / node:https.
//
// Why not fetch?  Node's built-in fetch (undici) silently injects
// `accept: */*`, `accept-language: *`, and `sec-fetch-mode: cors` on every
// request, none of which the real ToCodex VSCode extension sends.  For the
// CTF impersonation requirements we need byte-level control of the wire
// headers, so every outbound request goes through this helper instead.
//
// The caller is responsible for:
//   - Authoring the full header set (including Host and Content-Length).
//   - Providing a body with a matching Content-Length when applicable.
//
// No transformation is performed here: insertion order of the provided
// headers is preserved, and nothing is added, removed, or case-folded.

const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const { Readable } = require("node:stream");

// Shared keep-alive agents.  `keepAlive: true` matches how the ToCodex
// extension reuses connections; it does not cause Node to emit any extra
// headers on the request (Connection is authored by the caller).
const HTTP_AGENT = new http.Agent({ keepAlive: true });
const HTTPS_AGENT = new https.Agent({ keepAlive: true });

function request(url, { method = "GET", headers = {}, body, signal, timeoutMs } = {}) {
  const target = url instanceof URL ? url : new URL(url);
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;
  const agent = isHttps ? HTTPS_AGENT : HTTP_AGENT;

  const options = {
    method,
    host: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    headers,
    agent,
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(options);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const onAbort = () => {
      const reason =
        (signal && signal.reason) || new Error("aborted");
      req.destroy(reason);
      finish(reject, reason);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        const err = new Error("upstream timeout");
        err.code = "ETIMEDOUT";
        req.destroy(err);
      });
    }

    req.on("error", (err) => finish(reject, err));

    req.on("response", (res) => {
      // Transparently decompress the body when upstream responded
      // gzip/deflate/br — our header profiles that advertise
      // "accept-encoding: gzip, deflate" have to handle the reply.
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      let body = res;
      if (enc === "gzip") body = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") body = res.pipe(zlib.createInflate());
      else if (enc === "br") body = res.pipe(zlib.createBrotliDecompress());

      // Strip content-encoding + content-length from the headers we hand
      // back, so callers that repeat them to downstream don't double-count.
      const outHeaders = { ...res.headers };
      if (enc) {
        delete outHeaders["content-encoding"];
        delete outHeaders["content-length"];
      }

      finish(resolve, {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: outHeaders,
        body,
      });
    });

    if (body == null) {
      req.end();
    } else if (Buffer.isBuffer(body) || typeof body === "string") {
      req.end(body);
    } else if (body instanceof Readable || (body && typeof body.pipe === "function")) {
      body.on("error", (err) => {
        req.destroy(err);
        finish(reject, err);
      });
      body.pipe(req);
    } else {
      const err = new Error(
        "http-client: body must be Buffer | string | Readable | undefined"
      );
      req.destroy(err);
      finish(reject, err);
    }
  });
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJson(stream) {
  const buf = await readAll(stream);
  const text = buf.toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

module.exports = {
  request,
  readAll,
  readJson,
};
