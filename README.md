# Baytree AI

Classifies an inbound ManyChat message with an OpenRouter model, then triggers the ManyChat flow linked to that message type. Deploys as Vercel Functions; processing happens inline inside the request.

## Layout

| Path | Role |
| --- | --- |
| `api/send.js` | `POST` handler — validates, classifies, sends the flow |
| `api/health.js` | `GET` health probe |
| `api/index.js` | `GET /` — empty 200 |
| `src/lib.js` | Shared pipeline: Prisma, OpenRouter, ManyChat |
| `src/dev.js` | Local Bun server mounting the same handlers |

## Local development

Requires [Bun](https://bun.sh) 1.3+ and Postgres.

1. Copy `.env.example` to `.env` and fill it in.
2. `bun install` (runs `prisma generate` automatically)
3. `bun dev` — watch mode on `http://localhost:3000`

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Use a **pooled** URL in production. |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `OPENROUTER_MODEL` | Model id, default `openai/gpt-oss-120b` |
| `MANYCHAT_API_KEY` | ManyChat API key |
| `AI_TIMEOUT_MS` | Per-attempt classification timeout, default `10000` |
| `AI_MAX_ATTEMPTS` | Attempts when the model reports busy/rate-limited, default `2` |
| `PORT` | Local dev port, default `3000`. Unused on Vercel. |

## Endpoints

`vercel.json` rewrites `/send` and `/health` onto the `api/` functions, so both the short and `/api/...` forms work.

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
2. Deploy. `postinstall` runs `prisma generate`; no build step beyond that.

`api/send.js` is configured for `maxDuration: 60`. Hobby plans cap at 60s; the default without this is 10s, which one slow model call plus a retry can exceed.

## How classification works

The prompt is built once per instance from the `Message` table (`content` → `type`) and cached in module scope, so warm invocations skip the query. The model replies with a single number; `0` means no category matched. The `channel` + `type` pair is then looked up in `MessageFlow` (also cached) to get the ManyChat `flowId`.

## Notes

- Prisma, OpenRouter, and both caches are held on `globalThis` so they survive across warm invocations and are rebuilt on cold start.
- Serverless scales out to many instances, each with its own Postgres pool. Point `DATABASE_URL` at a pooler (Supabase pgBouncer, Neon pooled endpoint, PgBouncer) or connections will exhaust under load.
- Caches are per-instance and never invalidated. Editing `Message` or `MessageFlow` rows takes effect on the next cold start, not immediately — redeploy to force it.
