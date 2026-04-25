# ToCodex API Server

> **Research / CTF project.** Zero-dependency Node.js relay that speaks
> ToCodex's dynamic HMAC-SHA256 request-signing scheme, reverse-engineered
> from the [`ToCodex.tocodex`](https://marketplace.visualstudio.com/items?itemName=ToCodex.tocodex)
> VSCode extension (v3.1.3). Exposes **three client protocols** that all
> land on the same upstream (`POST https://api.tocodex.com/v1/chat/completions`):
>
> - **OpenAI Chat Completions** — passthrough, zero parsing. For NewAPI,
>   OneAPI, Cursor, LobeChat, continue.dev, any OpenAI-compatible gateway.
> - **Anthropic Messages** — full translation layer. For Claude Code via
>   `ANTHROPIC_BASE_URL`.
> - **OpenAI Responses** — full translation layer with in-memory session
>   history. For the new Codex CLI.
>
> Tool calls (`tool_use` / `tool_calls` / `function_call`) and images
> (base64 data URIs) are translated in both directions.

## Signing scheme

Extracted from the extension's minified `dist/extension.js`:

```js
const ts      = Math.floor(Date.now() / 1000).toString();
const nonce   = crypto.randomUUID();
const payload = `${ts}:${nonce}:POST:/v1/chat/completions`;
const sig     = crypto.createHmac("sha256", HMAC_SECRET)
                      .update(payload)
                      .digest("hex");
// headers: X-ToCodex-Timestamp, X-ToCodex-Nonce, X-ToCodex-Sig
```

Default secret (override via `TOCODEX_HMAC_SECRET`):

```
tc-hmac-s3cr3t-k3y-2026-tocodex-platform
```

## Routes

```
GET  /_health                               relay status + route list

# OpenAI passthrough
POST /v1/chat/completions                   signed passthrough
GET  /v1/models                             passthrough

# OpenAI Responses (Codex CLI)
POST /v1/responses                          translated, supports
                                            previous_response_id replay

# Anthropic Messages (Claude Code)
POST /anthropic/v1/messages                 translated
POST /anthropic/v1/messages/count_tokens    local heuristic estimate
GET  /anthropic/v1/models                   translated wrapper over /v1/models
```

---

## Run with Docker (recommended)

### `docker compose`

```bash
git clone https://github.com/handsomezhuzhu/tocodex_api_server.git
cd tocodex_api_server
cp .env.example .env   # optional: pin TOCODEX_API_KEY or TOCODEX_DEFAULT_MODEL
docker compose up -d
```

### One-liner

```bash
docker run -d --name tocodex-relay -p 8787:8787 \
  -e TOCODEX_API_KEY=$YOUR_TOCODEX_TOKEN \
  ghcr.io/handsomezhuzhu/tocodex_api_server:latest
```

### Build locally

```bash
docker build -t tocodex-api-server:dev .
docker run --rm -p 8787:8787 tocodex-api-server:dev
```

---

## Client integration

### OpenAI-compatible clients (NewAPI, OneAPI, Cursor, LobeChat, ...)

Point the client's **OpenAI base URL** at the relay:

```
http://127.0.0.1:8787/v1
```

Put a ToCodex token in the client's API key field (or set `TOCODEX_API_KEY`
server-side and put any non-empty placeholder in the client).

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $TOCODEX_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "model": "gpt-4o-mini",
        "stream": true,
        "messages": [{"role":"user","content":"hi"}]
      }'
```

### Claude Code (Anthropic protocol)

Set a ToCodex/OpenAI-side target model on the relay process first. This lets
the relay replace Claude Code's native `claude-*` model ids before forwarding
to ToCodex:

```bash
export TOCODEX_DEFAULT_MODEL=gpt-4o-mini
```

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic
export ANTHROPIC_API_KEY=$TOCODEX_TOKEN   # or "dummy" if TOCODEX_API_KEY is pinned
claude
```

Smoke test:

```bash
curl -N http://127.0.0.1:8787/anthropic/v1/messages \
  -H "x-api-key: $TOCODEX_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "max_tokens": 512,
    "stream": true,
    "messages": [{"role":"user","content":"say hi"}]
  }'
```

### Codex CLI (OpenAI Responses protocol)

Configure Codex's OpenAI provider with base URL:

```
http://127.0.0.1:8787/v1
```

The relay accepts `POST /v1/responses` (with `previous_response_id`) and
translates both directions.

```bash
curl -N http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $TOCODEX_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "stream": true,
    "instructions": "be concise",
    "input": "hello"
  }'
```

Follow-up turn using the returned `id`:

```bash
curl -N http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $TOCODEX_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "stream": true,
    "previous_response_id": "resp_...",
    "input": "one more"
  }'
```

---

## Run without Docker

```bash
cp .env.example .env
npm start              # no deps, Node 20+ only
npm test               # runs test/*.test.js (no framework)
npm run check          # syntax-only validation
```

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TOCODEX_API_URL` | `https://api.tocodex.com` | Upstream base |
| `TOCODEX_HMAC_SECRET` | `tc-hmac-s3cr3t-k3y-2026-tocodex-platform` | HMAC key |
| `TOCODEX_API_KEY` | *(empty)* | Pin a Bearer token; otherwise pass-through |
| `TOCODEX_SIGNED_PATHS` | `/v1/chat/completions` | Comma-separated list |
| `TOCODEX_SIGN_ALL_PATHS` | `false` | Sign every forwarded path |
| `TOCODEX_APP_VERSION` | `3.1.3` | Propagated as `X-Roo-App-Version` / UA |
| `TOCODEX_DEFAULT_MODEL` | *(empty)* | Fallback model; also replaces Claude model ids on `/anthropic` |
| `RESPONSES_SESSION_TTL_MS` | `1800000` | In-memory session TTL (30 min) |
| `RESPONSES_SESSION_MAX` | `500` | Max number of active sessions |
| `PORT` | `8787` | Listener port |
| `LISTEN_HOST` | `0.0.0.0` | Listener host |
| `HEALTH_PATH` | `/_health` | Health endpoint |
| `UPSTREAM_TIMEOUT_MS` | `600000` | Upstream request timeout |
| `CORS_ALLOW_ORIGIN` | `*` | CORS origin |
| `CORS_ALLOW_HEADERS` | `Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta` | CORS headers |
| `CORS_ALLOW_METHODS` | `GET,POST,PUT,PATCH,DELETE,OPTIONS` | CORS methods |

---

## Coverage & limitations

Supported:

- Anthropic: text, base64 images, `tool_use` / `tool_result`, `tools`,
  `tool_choice`, streaming SSE with `tool_use` argument reassembly.
- Responses: text, images (input), `function` tools, `previous_response_id`
  replay, streaming `response.output_text.delta` /
  `response.function_call_arguments.delta`.
- OpenAI passthrough stays lossless and zero-parse.

Deferred:

- Responses `computer_use`, image generation, file_search, retrieval items.
- Anthropic Bedrock / Vertex headers.
- Persistent session store (sessions are in-memory, lost on restart).
- Anthropic prompt caching headers.

---

## Notes / CTF caveats

- The HMAC secret shown above is what the extension ships with publicly; a
  real deployment might flip it at run time — set `TOCODEX_HMAC_SECRET` when
  that happens.
- Only `/v1/chat/completions` is signed by default, mirroring the extension.
  Flip `TOCODEX_SIGN_ALL_PATHS=true` to experiment with other endpoints.
- Replay-window / nonce protection is entirely server-side; the relay just
  generates fresh values on every call.

## License

[MIT](./LICENSE)
