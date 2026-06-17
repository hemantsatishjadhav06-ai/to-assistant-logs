# to-assistant-logs

Conversation log dashboard for the 3 TO Assistant chatbots, plus the human-agent (Zoho SalesIQ) handoff conversations:

- [to-assistant-tennis](https://github.com/hemantsatishjadhav06-ai/to-assistant-tennis)
- [to-assistant-padel](https://github.com/hemantsatishjadhav06-ai/to-assistant-padel)
- [to-assistant-pickleball](https://github.com/hemantsatishjadhav06-ai/to-assistant-pickleball)

Each bot fires a non-blocking POST to `/log` after every user query + AI response. Zoho SalesIQ posts to `/zoho` after every human-agent message. The dashboard at `/` shows every conversation as a chat-bubble card with sport, date, intent, and a clear AI vs Human pill.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`    | `/` | HTML dashboard, chat-bubble view, auto-refresh every 5s |
| `POST`   | `/log` | Bots POST conversation logs here (set as `SHEETS_WEBHOOK_URL` on each bot) |
| `POST`   | `/zoho` | Zoho SalesIQ webhook receiver — captures human-agent chats |
| `GET`    | `/api/logs?sport=&q=&limit=` | JSON: filter by sport, search text, limit |
| `GET`    | `/api/health` | Service health + buffer stats |
| `GET`    | `/debug/test?sport=tennis` | Inject a synthetic log row |
| `DELETE` | `/api/logs` | Wipe all logs (header `X-Admin-Key` must match `ADMIN_KEY` env var) |
| `GET`    | `/api/canned` | List canned replies (agent session) |
| `POST`   | `/api/canned` | Create a canned reply (admin only) |
| `PUT`    | `/api/canned/:id` | Update a canned reply (admin only) |
| `DELETE` | `/api/canned/:id` | Delete a canned reply (admin only) |
| `POST`   | `/api/upload` | Upload an attachment (agent); returns a public link |
| `GET`    | `/u/:id` | Public attachment download / inline preview |
| `GET`    | `/api/agents` | List agents for the transfer picker (agent) |
| `POST`   | `/api/claim` | Claim/assign a conversation to yourself (agent) |
| `POST`   | `/api/transfer` | Transfer a conversation to another agent (agent) |
| `POST`   | `/api/close` | Close a conversation — frees the assignment, resumes AI, acks the waiting alert, remembers the last agent (agent) |
| `POST`   | `/api/reopen` | Reopen a closed conversation (agent) |
| `GET`    | `/api/logs/test-summary` | Count automated test/QA entries (admin) |
| `POST`   | `/api/logs/purge-test` | Permanently delete test/QA entries (admin, confirm-gated) |

## Dashboard features

- **Chat-bubble cards** — customer message right-aligned, bot/human reply left-aligned. Looks like a copy of the chat conversation.
- **Date filter** — pick a from/to date range to see just one day, one week, one month.
- **Sport filter** — Tennis / Padel / Pickleball / All.
- **Source filter** — AI bot only / Human agent (Zoho) only / All.
- **Search** — full-text across query, response, intent, session ID.
- **Compact table view** — toggle for power users who prefer dense rows.
- **Canned replies** — in the reply box, type a keyword (e.g. `warranty`, `track`, `refund`) for an inline suggestion (↹ Tab to insert), or press ⌘/ for the full searchable palette. Manage the list in **/admin** (admins). Seeded with the standard Tennisoutlet replies; stored in `canned.json` in the data dir.
- **Attachments** — 📎 in the reply box uploads an image, PDF or document and drops a shareable link into the reply (also previewed in the thread).
- **Transfer to an agent** — 🔁 reassigns a live chat to a teammate; pauses AI, notifies them, and logs an internal note.
- **Hide / purge test data** — a 🧪 *Hide test data* toggle keeps automated QA/CI/test conversations out of the console; admins can permanently purge them from **/admin** → *Clean up test data*. Real `c_…` customer chats are always kept.

## Reconnect & reassignment

When a customer who was handled before asks for a human again (`POST /api/customer-needs-human`), the conversation is **reopened** and routed so it is never lost or stuck on an unavailable agent:

- **Closing.** Any stale assignment from the previous engagement is closed out. Closing a chat (`/api/close`) frees the assignment, turns AI back on for the customer, clears the "waiting" alert, and remembers who last handled it.
- **Same agent if available.** If the agent who handled the customer is still online, the chat is routed straight back to them (continuity). Toggle off with `RECONNECT_RETURN_TO_SAME_AGENT=off`.
- **Different agent if not.** If that agent is offline, the chat is **not** locked to them. By default it returns to the **Unclaimed** queue so any other available agent can pick it up. Set `RECONNECT_AUTO_ASSIGN_FALLBACK=on` to instead auto-assign the least-loaded *other* online agent.
- **Reopen in Unclaimed.** Because close state is now server-side, a closed chat that reconnects automatically leaves "Closed" and reappears in the dashboard (Unclaimed, or under whoever it was routed to) on the next poll.
- The header **"Live agents"** KPI shows how many support staff are online right now (presence-based), not the number of human-handled chats. *"Online"* means the agent's dashboard made an authenticated request within `PRESENCE_WINDOW_SEC`. Outside working hours the handoff is still suppressed (AI stays on), but the chat is reopened so the team sees it when they return.

## Setting up Zoho SalesIQ → /zoho webhook

1. Log into Zoho SalesIQ → **Settings → Developers → Webhooks** (or **Integrations → Webhooks** in newer UIs).
2. Click **Add webhook**.
3. Configure:
   - **Webhook name:** `TO Assistant Logs`
   - **URL:** `https://to-assistant-logs.onrender.com/zoho`
   - **Method:** `POST`
   - **Content-Type:** `application/json`
   - **Events to subscribe to:** chat message received, chat completed, chat connected
4. (Optional) Set the `sport` field at the brand/department level in Zoho so each chat tags its sport. Otherwise rows show `sport=unknown`.
5. Save.

The `/zoho` receiver is permissive — it parses the standard Zoho payload (visitor, operator, message, sender_type) and falls back to storing the raw JSON in the `meta` field if the shape is unexpected. You can test it from the command line:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"sport":"padel","chat_id":"test-1","sender_type":"operator","operator":{"name":"Demo Agent"},"message":"Hello, how can I help?"}' \
  https://to-assistant-logs.onrender.com/zoho
```

## Storage

In-memory ring buffer. Keeps the last `MAX_ENTRIES` (default 5000) entries. Persists across requests, lost on redeploy/restart. For permanent storage, swap in a database (Postgres / Supabase) — the surface area is small.

## Env vars

| Var | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `3000` | |
| `MAX_ENTRIES` | no | `5000` | Ring buffer cap |
| `ADMIN_KEY` | no | (unset) | Required to use `DELETE /api/logs` |
| `NODE_ENV` | no | `production` | |
| `RECONNECT_RETURN_TO_SAME_AGENT` | no | `on` | Route a reconnecting customer back to their previous agent if that agent is online |
| `RECONNECT_AUTO_ASSIGN_FALLBACK` | no | `off` | If the previous agent is offline, auto-assign the next available agent instead of using the Unclaimed queue |
| `PRESENCE_WINDOW_SEC` | no | `120` | An agent is counted as a "Live agent" only if their dashboard pinged within this many seconds (presence window) |
