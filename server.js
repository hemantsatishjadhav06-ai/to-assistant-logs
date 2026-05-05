// to-assistant-logs — conversation log dashboard for the 3 TO Assistant chatbots.
//
// Endpoints
//   POST  /log          — bots POST conversation logs here (set as SHEETS_WEBHOOK_URL)
//   GET   /             — HTML dashboard (table view, filterable)
//   GET   /api/logs     — JSON: ?sport=tennis&q=racket&limit=200
//   GET   /api/health   — service health
//   GET   /debug/test   — append a fake log entry (handy for verifying the loop)
//   DELETE /api/logs    — wipe all logs (requires header X-Admin-Key matching env var)
//
// Storage: in-memory ring buffer (last MAX_ENTRIES). Survives normal restarts on
// Render, lost on redeploy. For permanent storage, swap in a database later.

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_ENTRIES = parseInt(process.env.MAX_ENTRIES || '50000', 10);  // bumped — disk-backed now
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// Persistence: data dir survives redeploys IF a Render disk is mounted there.
// Without a disk, falls back to ephemeral local dir (data lost on redeploy).
const DATA_DIR = process.env.LOGS_DATA_DIR || path.join(__dirname, 'data');
const LOGS_FILE = path.join(DATA_DIR, 'logs.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const logs = [];
let totalReceived = 0;
const startTime = new Date();

// ===== AI toggle + handoff state (in-memory, persisted to disk) =====
// IMPORTANT: defaults are ALL ON. New sessions default to AI on — operator
// must explicitly toggle a customer or sport off. This is locked in by
// merging persisted state ON TOP of defaults rather than replacing them.
const aiState = {
  global: { tennis: 'on', padel: 'on', pickleball: 'on' },  // DEFAULT: ON
  perCustomer: {}  // empty by default — every new session inherits global=on
};
const pendingReplies = {};
const notifications = [];
let pendingReplyId = 0;
let notificationId = 0;

// ----- Load persisted logs + state on boot -----
function loadFromDisk() {
  // Logs (one JSON object per line)
  if (fs.existsSync(LOGS_FILE)) {
    try {
      const raw = fs.readFileSync(LOGS_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      let loaded = 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          logs.push(entry);
          if (entry.id && entry.id > totalReceived) totalReceived = entry.id;
          loaded++;
        } catch (_) {}
      }
      while (logs.length > MAX_ENTRIES) logs.shift();
      console.log(`[persist] loaded ${loaded} log entries from disk (totalReceived=${totalReceived})`);
    } catch (e) {
      console.warn('[persist] failed to load logs:', e.message);
    }
  } else {
    console.log('[persist] no logs file found — starting fresh');
  }

  // State (toggles + notifications)
  if (fs.existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Merge global on top of defaults — keeps tennis/padel/pickleball=on
      // unless explicitly persisted as 'off'.
      if (s.aiState && s.aiState.global) {
        for (const sport of Object.keys(aiState.global)) {
          if (s.aiState.global[sport] === 'on' || s.aiState.global[sport] === 'off') {
            aiState.global[sport] = s.aiState.global[sport];
          }
        }
      }
      // Per-customer overrides — full replace (only persisted ones survive)
      if (s.aiState && s.aiState.perCustomer) {
        Object.assign(aiState.perCustomer, s.aiState.perCustomer);
      }
      // Notifications — restore unread alerts
      if (Array.isArray(s.notifications)) {
        notifications.push(...s.notifications);
        notificationId = Math.max(notificationId, ...s.notifications.map(n => n.id || 0));
      }
      console.log(`[persist] loaded state — global=${JSON.stringify(aiState.global)}, perCustomer=${Object.keys(aiState.perCustomer).length} entries, notifications=${notifications.length}`);
    } catch (e) {
      console.warn('[persist] failed to load state:', e.message);
    }
  }
}

// ----- Save state to disk (debounced) -----
let saveTimer = null;
function saveStateDebounced() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        aiState,
        notifications: notifications.slice(-200)  // keep last 200
      }, null, 2));
      fs.renameSync(tmp, STATE_FILE);  // atomic
    } catch (e) {
      console.warn('[persist] save state failed:', e.message);
    }
  }, 300);
}

// ----- Append a single log line to disk (fire-and-forget) -----
function appendLogToDisk(entry) {
  fs.appendFile(LOGS_FILE, JSON.stringify(entry) + '\n', err => {
    if (err) console.warn('[persist] append log failed:', err.message);
  });
}

loadFromDisk();

function resolveAiOn(sport, sessionId) {
  if (sessionId && aiState.perCustomer[sessionId] !== undefined) {
    return { ai_on: aiState.perCustomer[sessionId] === 'on', source: 'session' };
  }
  if (sport && aiState.global[sport] !== undefined) {
    return { ai_on: aiState.global[sport] === 'on', source: 'global' };
  }
  return { ai_on: true, source: 'default' };
}

function pushLog(entry) {
  // Ensure entry id is monotonic — important after disk reload
  if (!entry.id || entry.id <= totalReceived) entry.id = totalReceived + 1;
  logs.push(entry);
  totalReceived = Math.max(totalReceived + 1, entry.id);
  while (logs.length > MAX_ENTRIES) logs.shift();
  appendLogToDisk(entry);
}

app.post('/log', (req, res) => {
  try {
    const b = req.body || {};
    const entry = {
      id: totalReceived + 1,
      received_at: new Date().toISOString(),
      timestamp: String(b.timestamp || new Date().toISOString()),
      sport: String(b.sport || 'unknown').toLowerCase(),
      session_id: String(b.session_id || ''),
      user_query: String(b.user_query || '').slice(0, 4000),
      ai_response: String(b.ai_response || '').slice(0, 8000),
      intent: String(b.intent || ''),
      endpoint: String(b.endpoint || ''),
      source: String(b.source || 'bot'),  // 'bot' = AI, 'human' = live agent (Zoho)
      agent_name: String(b.agent_name || ''),
      meta: String(b.meta || '')
    };
    pushLog(entry);
    res.json({ ok: true, id: entry.id });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// Zoho SalesIQ webhook receiver — accepts whatever Zoho's webhook posts and
// flattens the relevant fields into our log shape with source='human'.
// Setup: in Zoho SalesIQ → Settings → Developers → Webhooks → add a webhook
// pointing at https://to-assistant-logs.onrender.com/zoho with the events:
// chat.message, chat.completed (or "all chat events").
//
// Zoho sends slightly different payload shapes per event/version, so the
// extraction below is permissive — falls back to storing the raw JSON in
// `meta` if we can't recognize the shape.
app.post('/zoho', (req, res) => {
  try {
    const b = req.body || {};
    // Try several known shapes
    const visitor = b.visitor || b.chat_visitor || b.user || {};
    const operator = b.operator || b.agent || b.assigned_to || {};
    const message = b.message || b.last_message || b.chat_text || '';
    const messageBody = (typeof message === 'string') ? message : (message.text || message.content || '');
    const sport = String(b.sport || b.department || b.brand || 'unknown').toLowerCase();
    const sessionId = String(b.chat_id || b.visitor_id || b.session_id || visitor.id || '');

    // Determine if this message is FROM the visitor or FROM the human agent
    const senderType = String(b.sender_type || b.from || b.source || '').toLowerCase();
    const fromHuman = /operator|agent|attender|staff/.test(senderType);
    const fromVisitor = /visitor|customer|user/.test(senderType);

    const userText = fromVisitor ? messageBody : (b.visitor_message || visitor.message || '');
    const agentText = fromHuman ? messageBody : (b.operator_message || operator.message || '');

    const entry = {
      id: totalReceived + 1,
      received_at: new Date().toISOString(),
      timestamp: String(b.timestamp || b.event_time || b.created_at || new Date().toISOString()),
      sport,
      session_id: sessionId,
      user_query: String(userText || '').slice(0, 4000),
      ai_response: String(agentText || '').slice(0, 8000),  // for human responses
      intent: String(b.event || b.event_type || 'zoho_chat'),
      endpoint: '/zoho',
      source: 'human',
      agent_name: String(operator.name || operator.email || b.operator_name || ''),
      meta: JSON.stringify(b).slice(0, 4000)
    };
    pushLog(entry);
    res.json({ ok: true, id: entry.id });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

app.get('/api/logs', (req, res) => {
  const sport = (req.query.sport || '').toString().toLowerCase();
  const q = (req.query.q || '').toString().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, MAX_ENTRIES);

  let filtered = logs;
  if (sport) filtered = filtered.filter(l => l.sport === sport);
  if (q) {
    filtered = filtered.filter(l =>
      l.user_query.toLowerCase().includes(q) ||
      l.ai_response.toLowerCase().includes(q) ||
      l.intent.toLowerCase().includes(q) ||
      l.session_id.toLowerCase().includes(q)
    );
  }
  const slice = filtered.slice(-limit).reverse();
  res.json({
    total_in_buffer: logs.length,
    total_received: totalReceived,
    returned: slice.length,
    filters: { sport: sport || null, q: q || null, limit },
    logs: slice
  });
});

app.get('/api/health', (req, res) => {
  const pendingReplyCount = Object.values(pendingReplies).reduce((sum, arr) => sum + arr.filter(m => !m.delivered_at).length, 0);
  let dataSize = null;
  try {
    if (fs.existsSync(LOGS_FILE)) dataSize = fs.statSync(LOGS_FILE).size;
  } catch (_) {}
  res.json({
    status: 'running',
    version: '2.1.0',
    started_at: startTime.toISOString(),
    uptime_sec: Math.floor((Date.now() - startTime.getTime()) / 1000),
    total_received: totalReceived,
    in_buffer: logs.length,
    max_entries: MAX_ENTRIES,
    persistence: {
      data_dir: DATA_DIR,
      logs_file: LOGS_FILE,
      logs_file_bytes: dataSize
    },
    ai_state: {
      global: aiState.global,
      perCustomer_count: Object.keys(aiState.perCustomer).length
    },
    notifications: {
      total: notifications.length,
      unread: notifications.filter(n => n.status === 'unread').length
    },
    pending_human_replies: pendingReplyCount
  });
});

app.get('/debug/test', (req, res) => {
  const sport = (req.query.sport || 'tennis').toString().toLowerCase();
  pushLog({
    id: totalReceived + 1,
    received_at: new Date().toISOString(),
    timestamp: new Date().toISOString(),
    sport,
    session_id: 'debug',
    user_query: '[debug] is the logger working?',
    ai_response: '[debug] yes — this is a synthetic entry from /debug/test',
    intent: 'debug_test',
    endpoint: '/debug/test',
    meta: ''
  });
  res.json({ ok: true, message: 'fake log appended', total: totalReceived });
});

app.delete('/api/logs', (req, res) => {
  if (!ADMIN_KEY || req.get('X-Admin-Key') !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const cleared = logs.length;
  logs.length = 0;
  res.json({ ok: true, cleared });
});

// ============================================================
// AI toggle + human handoff endpoints (v2.0)
// ============================================================

// GET /api/state?sport=tennis&session_id=abc — bot calls this every chat turn
app.get('/api/state', (req, res) => {
  const sport = String(req.query.sport || '').toLowerCase();
  const sessionId = String(req.query.session_id || '');
  res.json(resolveAiOn(sport, sessionId));
});

// GET /api/state-all — dashboard reads everything for the toggle UI
app.get('/api/state-all', (req, res) => {
  res.json({
    global: aiState.global,
    perCustomer: aiState.perCustomer,
    notifications: notifications.filter(n => n.status === 'unread').length
  });
});

// POST /api/toggle  body: {scope:'global'|'session', id, value:'on'|'off'}
app.post('/api/toggle', (req, res) => {
  const { scope, id, value } = req.body || {};
  if (!['global', 'session'].includes(scope)) return res.status(400).json({ ok: false, error: 'bad scope' });
  if (!['on', 'off'].includes(value)) return res.status(400).json({ ok: false, error: 'bad value' });
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  if (scope === 'global') {
    if (!['tennis', 'padel', 'pickleball'].includes(id)) return res.status(400).json({ ok: false, error: 'bad sport' });
    aiState.global[id] = value;
  } else {
    aiState.perCustomer[id] = value;
  }
  saveStateDebounced();
  console.log(`[toggle] ${scope}=${id} → ${value}`);
  res.json({ ok: true, scope, id, value });
});

// POST /api/customer-needs-human  body: {session_id, sport}
// Called by bot when customer clicks "Talk to a human" button OR auto-handoff fires.
app.post('/api/customer-needs-human', (req, res) => {
  const { session_id, sport, type } = req.body || {};
  if (!session_id) return res.status(400).json({ ok: false, error: 'session_id required' });
  // Auto-flip per-customer toggle to OFF
  aiState.perCustomer[session_id] = 'off';
  // Push notification
  const notif = {
    id: ++notificationId,
    session_id,
    sport: String(sport || 'unknown').toLowerCase(),
    type: String(type || 'talk_to_human'),
    timestamp: new Date().toISOString(),
    status: 'unread'
  };
  notifications.push(notif);
  while (notifications.length > 500) notifications.shift();
  saveStateDebounced();
  console.log(`[notify] ${notif.sport}/${session_id} requested human (type=${notif.type})`);
  res.json({ ok: true, notification_id: notif.id });
});

// POST /api/human-message  body: {session_id, text, agent_name, sport}
// Operator types a reply in the dashboard → message goes here → bot polls and delivers.
app.post('/api/human-message', (req, res) => {
  const { session_id, text, agent_name, sport } = req.body || {};
  if (!session_id || !text) return res.status(400).json({ ok: false, error: 'session_id + text required' });
  const msg = {
    id: ++pendingReplyId,
    text: String(text).slice(0, 4000),
    agent_name: String(agent_name || 'Support'),
    timestamp: new Date().toISOString(),
    delivered_at: null
  };
  if (!pendingReplies[session_id]) pendingReplies[session_id] = [];
  pendingReplies[session_id].push(msg);
  // Also log it so the dashboard sees it in the conversation thread
  pushLog({
    id: totalReceived + 1,
    received_at: new Date().toISOString(),
    timestamp: msg.timestamp,
    sport: String(sport || 'unknown').toLowerCase(),
    session_id,
    user_query: '',
    ai_response: msg.text,
    intent: 'human_reply',
    endpoint: '/api/human-message',
    source: 'human',
    agent_name: msg.agent_name,
    meta: ''
  });
  console.log(`[human-msg] sport=${sport} session=${session_id} agent=${msg.agent_name} text="${msg.text.slice(0,80)}"`);
  res.json({ ok: true, id: msg.id });
});

// GET /api/poll-replies?session_id=&since= — returns undelivered replies for that session.
// Called by bot's chat widget on a 2s loop. `since` is the last-seen reply id.
app.get('/api/poll-replies', (req, res) => {
  const sessionId = String(req.query.session_id || '');
  const since = parseInt(req.query.since || '0', 10) || 0;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'session_id required' });
  const queue = pendingReplies[sessionId] || [];
  const fresh = queue.filter(m => m.id > since);
  // Mark them delivered (informational)
  for (const m of fresh) if (!m.delivered_at) m.delivered_at = new Date().toISOString();
  res.json({ messages: fresh, count: fresh.length });
});

// GET /api/notifications?since= — dashboard polls for new alerts (talk-to-human).
app.get('/api/notifications', (req, res) => {
  const since = parseInt(req.query.since || '0', 10) || 0;
  const fresh = notifications.filter(n => n.id > since);
  const unreadCount = notifications.filter(n => n.status === 'unread').length;
  res.json({ notifications: fresh, unread_count: unreadCount });
});

// POST /api/notifications/ack  body: {ids:[...]}
app.post('/api/notifications/ack', (req, res) => {
  const ids = (req.body && req.body.ids) || [];
  const idSet = new Set(ids.map(Number));
  let acked = 0;
  for (const n of notifications) {
    if (idSet.has(n.id) && n.status === 'unread') { n.status = 'read'; acked++; }
  }
  if (acked) saveStateDebounced();
  res.json({ ok: true, acked });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[logs] listening on :${PORT} (max_entries=${MAX_ENTRIES})`);
});
