# Baytree AI

Classifies an inbound ManyChat message with an OpenRouter model, then triggers the ManyChat flow linked to that message type. Express app on Bun, locally and on Vercel's Bun runtime; processing happens inline inside the request.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | Entrypoint — express app and routes |
| `src/handlers.js` | Route handlers: validation, response shaping |
| `src/lib.js` | Pipeline: Prisma, OpenRouter, ManyChat |

## Local development

Requires [Bun](https://bun.sh) 1.3+ and Postgres.

1. Copy `.env.example` to `.env` and fill it in.
2. `bun install` (runs `prisma generate` automatically)
3. `bun dev` — watch mode on `http://localhost:3000`

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Use a **pooled** URL in production. |
| `GOOGLE_API_KEY` | Google AI Studio key — the primary classifier |
| `GEMINI_MODEL` | Model id, default `gemini-3.5-flash-lite` |
| `OPENROUTER_API_KEY` | Optional fallback provider. Leave empty to disable the fallback. |
| `OPENROUTER_MODEL` | Fallback model id, default `openai/gpt-oss-120b` |
| `MANYCHAT_API_KEY` | ManyChat API key |
| `AI_TIMEOUT_MS` | Per-attempt classification timeout, default `10000` |
| `AI_MAX_ATTEMPTS` | Attempts when the model reports busy/rate-limited, default `2` |
| `DEBUG_CLASSIFY` | Set to `1` to log each message, its code points, and the model's raw reply |
| `PORT` | Port to bind, default `3000`. Vercel sets this itself. |

## Endpoints

- `GET /` — empty 200
- `GET /health` — `{ "status": "ok", "uptime": <seconds> }`
- `POST /send` — classify and dispatch

### `POST /send`

```json
{
  "channel": "ig",
  "subscriberId": 123456789,
  "message": "do you have blonde dye in stock?"
}
```

`channel` must be `ig` or `wp`. `subscriberId` may be a number or numeric string.

Responds `200 { "status": "ok", "channel": "ig", "subscriberId": 123456789, "type": 1, "flowId": "...", "sent": true }`. When no flow matches the classified type, `flowId` is `null` and `sent` is `false` — still a 200, since nothing failed.

## Deploying to Vercel

1. Set every variable above in Project Settings → Environment Variables.
2. Deploy. `bun.lock` makes Vercel pick the Bun runtime, which uses root `index.js` as its entrypoint. `postinstall` runs `prisma generate`; no build step beyond that.

Vercel's Bun runtime only supports Express — it statically scans the entrypoint for an `express` import. Keep that import and the app in `index.js`; moving them into a module breaks detection with `No entrypoint found which imports express`.

If a slow model call plus a retry ever exceeds the function duration limit, lower `AI_TIMEOUT_MS` / `AI_MAX_ATTEMPTS` or raise the limit in Project Settings.

## How classification works

The prompt is built once per instance from the `Message` table (`content` → `type`) and cached in module scope, so warm invocations skip the query. The model replies with a single number; `0` means no category matched. The `channel` + `type` pair is then looked up in `MessageFlow` (also cached) to get the ManyChat `flowId`.

Customers write Egyptian Arabic, in Arabic script or in Franco-Arabic/Arabizi (Latin letters with digits standing in for Arabic letters). The system prompt states this explicitly and includes the transliteration key — without it, the same question spelled two ways gets classified two different ways.

Gemini handles every request. If it errors or hits its free-tier limit, the request falls back to OpenRouter so a customer message is never dropped. Measured on 14 Egyptian Arabic / Franco messages against the live categories:

| Model | Correct | Notes |
| --- | --- | --- |
| `gemini-3.5-flash-lite` | 14/14 | free tier, ~0.5s |
| `gemini-3.6-flash` | 14/14 | free tier, ~10x slower |
| `openai/gpt-oss-120b` | 13/14 | paid, ~$0.00008/message |
| `nvidia/nemotron-3-nano-30b-a3b:free` | 10/14 | unreliable on dialect; also unstable across runs |

Model choice dominates accuracy here. The nano model returned three different answers for one message across runs, which is what "the AI is bad at Arabic" actually looked like.

## Notes

- `prisma/schema.prisma` uses the `prisma-client-js` generator, not the newer `prisma-client`. The latter emits TypeScript, which Bun runs directly but Node cannot — on Vercel that surfaces as `ERR_MODULE_NOT_FOUND ... internal/class.ts`. Setting `generatedFileExtension` does not help; it renames the files without changing their contents.
- `bun dev` loads `.env` automatically. Running the same entrypoint under plain `node` does not, and fails at connect time with `SASL: ... client password must be a string`. On Vercel the platform supplies the variables, so this only affects local Node runs.
- Prisma, OpenRouter, and both caches are held on `globalThis` so they survive across warm invocations and are rebuilt on cold start.
- Serverless scales out to many instances, each with its own Postgres pool. Point `DATABASE_URL` at a pooler (Supabase pgBouncer, Neon pooled endpoint, PgBouncer) or connections will exhaust under load.
- Caches are per-instance and never invalidated. Editing `Message` or `MessageFlow` rows takes effect on the next cold start, not immediately — redeploy to force it.
