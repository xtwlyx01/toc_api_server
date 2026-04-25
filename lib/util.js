"use strict";

const crypto = require("node:crypto");

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function safeJsonParse(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return null;
  }
}

function parseBearer(value) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^\s*Bearer\s+(.+)$/iu);
  return m ? m[1].trim() : null;
}

// Resolve the upstream ToCodex API key for a request. Order of preference:
//   1. relay-level default (env TOCODEX_API_KEY)
//   2. Authorization: Bearer <token> from the client
//   3. x-api-key from the client (Anthropic style)
function resolveApiKey(req, config) {
  if (config.defaultApiKey) return config.defaultApiKey;
  const auth = req.headers["authorization"] || req.headers["Authorization"];
  const bearer = parseBearer(Array.isArray(auth) ? auth[0] : auth);
  if (bearer) return bearer;
  const xkey = req.headers["x-api-key"];
  if (xkey) return (Array.isArray(xkey) ? xkey[0] : xkey).trim();
  return null;
}

// Buffer a request body into a raw Buffer with a size cap.  Returns the
// concatenated Buffer (possibly empty) or throws an Error with a
// `.statusCode` for the caller to translate to HTTP.
async function readRawBody(req, { maxBytes = 10 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      const err = new Error(`request body exceeds ${maxBytes} bytes`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(buf);
  }
  return total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total);
}

// Buffer a JSON request body with a size cap. Returns the parsed JSON or
// throws an Error with a `.statusCode` for us to translate to HTTP.
async function readJsonBody(req, opts = {}) {
  const buf = await readRawBody(req, opts);
  if (buf.length === 0) return {};
  const raw = buf.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`invalid JSON body: ${e.message}`);
    err.statusCode = 400;
    throw err;
  }
}

module.exports = { newId, safeJsonParse, parseBearer, resolveApiKey, readJsonBody, readRawBody };
