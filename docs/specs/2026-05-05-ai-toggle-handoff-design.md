# AI Toggle + Human Handoff — Design

_Date: 2026-05-05 · Status: approved_

## Goal

Let support staff (a) take over any customer chat from the AI bot at will, (b) know instantly when a customer asks for a human, and (c) reply directly from the dashboard. The customer's existing chat widget keeps working — the experience is seamless from their side.

## Behaviour

| Event | Outcome |
|---|---|
| Operator clicks per-customer toggle OFF | AI stops responding to that customer. Reply box on the card becomes the primary path. |
| Operator clicks global sport toggle OFF | All AI for that sport stops. Per-customer overrides still apply. |
| Customer clicks "Talk to a human" button | Per-customer toggle auto-flips OFF. Card border turns red. Sound plays once. Header shows "🔴 N waiting" counter. |
| Operator types reply + Send | Customer sees it in their widget within ~2s (polling). |
| Operator toggles back ON | Next customer message goes to AI again. |

## Architecture

```
                 ┌─────────────────────┐
   Customer ───▶ │   Bot service       │ ──┐
   (widget)      │   (3 services)      │   │  state queries
                 │   tennis/padel/picl │   │  human-msg poll
                 └──────────┬──────────┘   │
                            │              │
                  log / poll-replies       │
                            │              ▼
                            │    ┌─────────────────────┐
                            └──▶ │  Logger service     │
                                 │  (to-assistant-logs)│
                                 │                     │
                                 │  state:             │
                                 │   - aiState.global  │
                                 │   - aiState.perCust │
                                 │   - pendingReplies  │
                                 │   - notifications   │
                                 │   - logs (existing) │
                                 └──────────┬──────────┘
                                            │
                                            │  REST + 5s polling
                                            ▼
                                 ┌─────────────────────┐
                                 │  Dashboard          │
                                 │  (operator console) │
                                 └─────────────────────┘
```

The logger service holds all NEW state. Bots are stateless w.r.t. handoff (they query the logger for every chat turn). This means restarting any single bot doesn't lose handoff state.

## State model (in logger memory)

```js
aiState = {
  global: { tennis: 'on', padel: 'on', pickleball: 'on' },   // master switch per sport
  perCustomer: { '<session_id>': 'on' | 'off' }               // optional override
};
pendingReplies = {
  '<session_id>': [{ id, text, agent_name, timestamp, delivered }]
};
notifications = [
  { id, session_id, sport, type: 'talk_to_human' | 'auto_handoff', timestamp, status: 'unread' | 'read' }
];
```

State is in-memory (lost on logger restart, like the logs themselves). Acceptable for v1 — small support team, low cost; can swap to Postgres later.

## Resolution rule

For a given chat turn, AI is ON iff:
1. `aiState.perCustomer[session_id]` is undefined, AND `aiState.global[sport]` === 'on', OR
2. `aiState.perCustomer[session_id]` === 'on'.

In other words: per-customer overrides global. Default (no entry) = on.

## API surface (added to logger service)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET    | /api/state?sport=&session_id= | — | `{ai_on: boolean, source: 'global'|'session'|'default'}` |
| POST   | /api/toggle | `{scope: 'global'\|'session', id, value}` | `{ok}` |
| POST   | /api/human-message | `{session_id, text, agent_name, sport}` | `{ok, id}` |
| GET    | /api/poll-replies?session_id=&since= | — | `{messages:[...]}` |
| POST   | /api/customer-needs-human | `{session_id, sport}` | `{ok}` |
| GET    | /api/notifications?since= | — | `{notifications:[...], unread_count}` |
| POST   | /api/notifications/ack | `{ids:[...]}` | `{ok}` |

## API surface (added to each bot service)

The chat widget on tennisoutlet.in (etc.) is served by the bot. To avoid CORS issues from the widget calling logger directly, the bot proxies these:

| Method | Path | Purpose |
|---|---|---|
| POST | /api/talk-to-human | Widget button calls this. Bot forwards to logger /api/customer-needs-human and returns "Connecting you to a human now…" |
| GET  | /api/poll?session_id=&since= | Widget polls every 2s. Bot fetches new human messages from logger, returns them. |

The existing /api/chat-agents handler also gains a state check at the top: if `ai_on` is false, store the customer message as a log entry (no AI reply) and return a polite hold response.

## UI changes

### Dashboard
- 3 master toggles in the header (sport-level)
- Per-card toggle in the customer header
- Reply box on each card (always visible — see "edge cases" for why)
- Notification badge in header: `🔴 3 waiting` (count of unread notifications)
- Card border turns red when that customer has an unread "talk to human" notification
- Soft notification sound on new alert (suppressed for 2s after load to avoid replay)

### Chat widget (served by bot at /)
- New "Talk to a human" button below the input
- Polling every 2 seconds for human replies when in handoff mode
- "Agent is typing…" or "Connecting you to an agent…" indicator

## Failure modes

| What if | Behavior |
|---|---|
| Logger is down | Bot defaults to AI ON (fail-open: customer still gets help) |
| Logger memory wiped (restart) | Toggles reset to default (AI ON for all). Pending human messages lost. Operator notices on next refresh. |
| Customer reloads page | New session_id; new toggle defaults to AI ON. Previous conversation is in logs but not in the new session. |
| Two operators reply at once | Both messages stored, both delivered to customer in order. (No locking — small team, acceptable race.) |
| Widget polling fails (network) | Widget retries on next interval. Backoff after 5 consecutive failures. |

## Out of scope (v1)

- Persistent storage (Postgres) — add later if needed
- Multi-agent collaboration / typing indicators between agents
- Canned replies / quick-action buttons
- File / image attachments in human reply
- Email / Slack notifications (only in-tab badge + sound for v1)
- Replacing Zoho SalesIQ — they coexist; this system is the new primary path, Zoho remains for cases the bot escalates via `<<OPEN_HUMAN_CHAT>>`

## Approval

Approved by user 2026-05-05 ("ok build test verify"). Building now.
