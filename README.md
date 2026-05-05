# to-assistant-logs

Conversation log dashboard for the 3 TO Assistant chatbots:

- [to-assistant-tennis](https://github.com/hemantsatishjadhav06-ai/to-assistant-tennis)
- [to-assistant-padel](https://github.com/hemantsatishjadhav06-ai/to-assistant-padel)
- [to-assistant-pickleball](https://github.com/hemantsatishjadhav06-ai/to-assistant-pickleball)

Each bot fires a non-blocking POST to this service after every user query + AI response. Open the root URL to see a live, filterable table of every conversation across all 3 sports.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | HTML dashboard, auto-refresh every 5s |
| `POST` | `/log` | Bots POST conversation logs here (set as `SHEETS_WEBHOOK_URL`) |
| `GET` | `/api/logs?sport=&q=&limit=` | JSON: filter by sport, search text, limit |
| `GET` | `/api/health` | Service health + buffer stats |
| `GET` | `/debug/test?sport=tennis` | Inject a synthetic log row (handy for verifying the loop end-to-end) |
| `DELETE` | `/api/logs` | Wipe all logs (header `X-Admin-Key` must match `ADMIN_KEY` env var) |

## Storage

In-memory ring buffer. Keeps the last `MAX_ENTRIES` (default 5000) entries. Persists across requests, lost on redeploy/restart. For permanent storage, swap in a database (Postgres / Supabase) — the surface area is small.

## Env vars

| Var | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `3000` | |
| `MAX_ENTRIES` | no | `5000` | Ring buffer cap |
| `ADMIN_KEY` | no | (unset) | Required to use `DELETE /api/logs` |
| `NODE_ENV` | no | `production` | |
