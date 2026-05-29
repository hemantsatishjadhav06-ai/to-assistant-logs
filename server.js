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
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_ENTRIES = parseInt(process.env.MAX_ENTRIES || '50000', 10);  // bumped — disk-backed now
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// ===== AUTH (v3.0) =====
// DASHBOARD_PASSWORD: shared password for all support agents. Required to log in.
// BOT_AUTH_TOKEN:     shared secret bots must send as Authorization: Bearer <token>
//                     when calling /log, /api/state, /api/poll-replies,
//                     /api/customer-needs-human. Prevents random people from
//                     spamming logs or firing fake "talk to human" notifications.
// If either env var is unset, that auth layer is disabled (open mode) — log a
// warning at boot. Production must have both.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const BOT_AUTH_TOKEN = process.env.BOT_AUTH_TOKEN || '';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map(); // sessionId -> { agent_name, expires_at }
const loginAttempts = new Map(); // ip -> [timestamps] (for rate-limit)

// ===== v3 multi-user auth: users seeded from AGENT_USERS env (durable across redeploys) =====
// AGENT_USERS = JSON array of { id, name, role:'admin'|'agent', salt, hash }
// hash = sha256(salt + password). Plaintext passwords are NEVER stored.
const users = new Map(); // id(lowercase) -> { id, name, role, salt, hash, seeded }
function hashPw(salt, pw) { return crypto.createHash('sha256').update(String(salt) + String(pw)).digest('hex'); }
(function seedUsers() {
  try {
    if (!process.env.AGENT_USERS) return;
    const arr = JSON.parse(process.env.AGENT_USERS);
    for (const u of arr) {
      if (u && u.id && u.hash && u.salt) {
        users.set(String(u.id).toLowerCase(), {
          id: String(u.id), name: String(u.name || u.id),
          role: u.role === 'admin' ? 'admin' : 'agent',
          salt: String(u.salt), hash: String(u.hash), seeded: true
        });
      }
    }
    console.log(`[auth] seeded ${users.size} users from AGENT_USERS`);
  } catch (e) { console.warn('[auth] AGENT_USERS parse failed:', e.message); }
})();
function findUser(id) { return users.get(String(id || '').toLowerCase()); }

// Tiny inline cookie helpers — no deps
function parseCookies(req) {
  const out = {};
  const c = req.headers.cookie || '';
  c.split(';').forEach(p => {
    const idx = p.indexOf('=');
    if (idx < 0) return;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k) try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}
function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}
function safeEqStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}
function newSessionId() { return crypto.randomBytes(32).toString('hex'); }
function getSession(req) {
  const sid = parseCookies(req)['to_session'];
  if (!sid) return null;
  const sess = sessions.get(sid);
  if (!sess) return null;
  if (sess.expires_at < Date.now()) { sessions.delete(sid); return null; }
  return sess;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
}
// Periodic session cleanup (no leaks)
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.expires_at < now) sessions.delete(sid);
  for (const [ip, ts] of loginAttempts) {
    const fresh = ts.filter(t => now - t < 60_000);
    if (fresh.length === 0) loginAttempts.delete(ip);
    else loginAttempts.set(ip, fresh);
  }
}, 5 * 60 * 1000).unref();

// Middleware: require an authenticated agent (cookie session)
function requireAgent(req, res, next) {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ ok: false, error: 'auth_required' });
  req.agent = sess;
  next();
}
function requireAdmin(req, res, next) {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ ok: false, error: 'auth_required' });
  if (sess.role !== 'admin') return res.status(403).json({ ok: false, error: 'admin_required' });
  req.agent = sess;
  next();
}
// Middleware: require bot auth (Authorization: Bearer <token>)
function requireBot(req, res, next) {
  if (!BOT_AUTH_TOKEN) return next(); // open mode — warned at boot
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${BOT_AUTH_TOKEN}`;
  if (!safeEqStr(auth, expected)) {
    return res.status(401).json({ ok: false, error: 'bot_auth_required' });
  }
  next();
}

// Persistence: data dir survives redeploys IF a Render disk is mounted there.
// Without a disk, falls back to ephemeral local dir (data lost on redeploy).
const DATA_DIR = process.env.LOGS_DATA_DIR || path.join(__dirname, 'data');
const LOGS_FILE = path.join(DATA_DIR, 'logs.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

app.set('trust proxy', 1);

// ===== v2.2 SECURITY HARDENING =====
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; media-src 'self' data:");
  next();
});

// Per-bot-token sliding-window rate limit
const _botRate = new Map();
function botRateLimit(maxPerMin) {
  return (req, res, next) => {
    if (!BOT_AUTH_TOKEN) return next();
    const auth = req.headers['authorization'] || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tok) return next();
    const key = crypto.createHash('sha256').update(tok).digest('hex').slice(0, 16);
    const now = Date.now();
    const arr = (_botRate.get(key) || []).filter(t => now - t < 60_000);
    if (arr.length >= maxPerMin) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ ok: false, error: 'rate_limited', limit: maxPerMin, window_sec: 60 });
    }
    arr.push(now);
    _botRate.set(key, arr);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of _botRate) {
    const f = arr.filter(t => now - t < 60_000);
    if (!f.length) _botRate.delete(k); else _botRate.set(k, f);
  }
}, 60_000).unref();

// Audit log — append-only JSONL
const AUDIT_FILE = path.join(process.env.LOGS_DATA_DIR || '/var/data', 'audit.jsonl');
function audit(req, action, target, before, after) {
  try {
    const sess = (typeof getSession === 'function') ? getSession(req) : null;
    const auth = req.headers['authorization'] || '';
    const isBot = auth.startsWith('Bearer ');
    const entry = {
      ts: new Date().toISOString(),
      actor_type: sess ? 'agent' : (isBot ? 'bot' : 'anon'),
      actor: sess ? sess.agent_name : (isBot ? 'bot' : null),
      action, target,
      before: before === undefined ? null : before,
      after: after === undefined ? null : after,
      ip: clientIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 200)
    };
    fs.appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', () => {});
  } catch (_) {}
}


// CORS: same-origin XHR (dashboard JS calling its own API) doesn't need CORS.
// Bot calls send credentials in Authorization header, not cookies — also fine.
// Restrict to specific origins to prevent cross-origin reads of customer logs.
app.use(cors({
  origin: false,            // disallow cross-origin browsers from reading
  credentials: true
}));
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

// ============================================================
// AUTH endpoints (v3.0)
// ============================================================
// POST /api/login — body: {password, agent_name} → sets session cookie
app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  // Rate limit: 5 attempts per minute per IP
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter(t => now - t < 60_000);
  if (attempts.length >= 5) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts' });
  }
  attempts.push(now);
  loginAttempts.set(ip, attempts);

  const body = req.body || {};
  const loginId = String(body.id || body.agent_name || '').trim();
  const password = body.password;
  if (!loginId || !password) {
    return res.status(400).json({ ok: false, error: 'id_and_password_required' });
  }
  let sess = null;
  if (users.size > 0) {
    const u = findUser(loginId);
    if (!u || !safeEqStr(hashPw(u.salt, String(password)), u.hash)) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }
    sess = { agent_name: u.name, id: u.id, role: u.role, expires_at: now + SESSION_TTL_MS };
  } else if (DASHBOARD_PASSWORD) {
    if (!safeEqStr(String(password), DASHBOARD_PASSWORD)) {
      return res.status(401).json({ ok: false, error: 'invalid_password' });
    }
    sess = { agent_name: loginId.slice(0, 60), id: loginId.toLowerCase(), role: 'agent', expires_at: now + SESSION_TTL_MS };
  } else {
    return res.status(500).json({ ok: false, error: 'server_not_configured' });
  }
  const sid = newSessionId();
  sessions.set(sid, sess);
  loginAttempts.delete(ip);
  setCookie(res, 'to_session', sid, { maxAge: SESSION_TTL_MS / 1000 });
  console.log(`[auth] login ok: id="${sess.id}" role=${sess.role} ip=${ip}`);
  res.json({ ok: true, agent_name: sess.agent_name, role: sess.role });
});

// POST /api/logout — clears session
app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req)['to_session'];
  if (sid) sessions.delete(sid);
  setCookie(res, 'to_session', '', { maxAge: 0 });
  res.json({ ok: true });
});

// GET /api/me — returns current agent (requires auth)
app.get('/api/me', requireAgent, (req, res) => {
  res.json({ ok: true, agent_name: req.agent.agent_name, id: req.agent.id || null, role: req.agent.role || 'agent' });
});

// ===== v3 admin: manage agent profiles (admin only) =====
app.get('/api/users', requireAdmin, (req, res) => {
  res.json({ ok: true, users: Array.from(users.values()).map(u => ({ id: u.id, name: u.name, role: u.role, seeded: !!u.seeded })) });
});
app.post('/api/users', requireAdmin, (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '').trim().toLowerCase().slice(0, 40);
  const name = String(b.name || id).trim().slice(0, 60);
  const role = b.role === 'admin' ? 'admin' : 'agent';
  const password = String(b.password || '');
  if (!id || !password) return res.status(400).json({ ok: false, error: 'id_and_password_required' });
  if (!/^[a-z0-9._-]+$/.test(id)) return res.status(400).json({ ok: false, error: 'id_must_be_alphanumeric' });
  if (users.has(id)) return res.status(409).json({ ok: false, error: 'id_exists' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'password_too_short' });
  const salt = crypto.randomBytes(8).toString('hex');
  users.set(id, { id, name, role, salt, hash: hashPw(salt, password), seeded: false });
  audit(req, 'create_user', id, null, { name, role });
  console.log(`[admin] created user id="${id}" role=${role} by ${req.agent.agent_name}`);
  res.json({ ok: true, user: { id, name, role } });
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  const u = users.get(id);
  if (!u) return res.status(404).json({ ok: false, error: 'not_found' });
  if (u.seeded) return res.status(400).json({ ok: false, error: 'cannot_delete_seeded_user' });
  if (id === (req.agent.id || '')) return res.status(400).json({ ok: false, error: 'cannot_delete_self' });
  users.delete(id);
  audit(req, 'delete_user', id, { name: u.name, role: u.role }, null);
  res.json({ ok: true });
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ============================================================
// BOT-FACING endpoints (require BOT_AUTH_TOKEN)
// ============================================================
app.post('/log', botRateLimit(300), requireBot, (req, res) => {
  try {
    const b = req.body || {};
    const entry = {
      id: totalReceived + 1,
      received_at: new Date().toISOString(),
      timestamp: String(b.timestamp || new Date().toISOString()),
      sport: String(b.sport || 'unknown').toLowerCase(),
      session_id: String(b.session_id || ''),
      customer_name: String(b.customer_name || '').slice(0, 120),
      customer_email: String(b.customer_email || '').slice(0, 200),
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
      customer_name: String((visitor && visitor.name) || b.visitor_name || '').slice(0, 120),
      customer_email: String((visitor && visitor.email) || b.visitor_email || b.email || '').slice(0, 200),
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

// ============================================================
// DASHBOARD-FACING endpoints (require agent session cookie)
// ============================================================
app.get('/api/logs', requireAgent, (req, res) => {
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
      l.session_id.toLowerCase().includes(q) ||
      (l.customer_name||'').toLowerCase().includes(q) ||
      (l.customer_email||'').toLowerCase().includes(q)
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

app.get('/healthz', (req, res) => res.json({ ok: true }));

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
app.get('/api/state', requireBot, (req, res) => {
  const sport = String(req.query.sport || '').toLowerCase();
  const sessionId = String(req.query.session_id || '');
  res.json(resolveAiOn(sport, sessionId));
});

// GET /api/state-all — dashboard reads everything for the toggle UI
app.get('/api/state-all', requireAgent, (req, res) => {
  res.json({
    global: aiState.global,
    perCustomer: aiState.perCustomer,
    notifications: notifications.filter(n => n.status === 'unread').length
  });
});

// POST /api/toggle  body: {scope:'global'|'session', id, value:'on'|'off'}
app.post('/api/toggle', requireAgent, (req, res) => {
  const { scope, id, value } = req.body || {};
  if (!['global', 'session'].includes(scope)) return res.status(400).json({ ok: false, error: 'bad scope' });
  if (!['on', 'off'].includes(value)) return res.status(400).json({ ok: false, error: 'bad value' });
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const _before = scope === 'global' ? aiState.global[id] : aiState.perCustomer[id];
  if (scope === 'global') {
    if (!['tennis', 'padel', 'pickleball'].includes(id)) return res.status(400).json({ ok: false, error: 'bad sport' });
    aiState.global[id] = value;
  } else {
    aiState.perCustomer[id] = value;
  }
  saveStateDebounced();
  audit(req, 'toggle_ai', `${scope}:${id}`, _before, value);
  console.log(`[toggle] ${scope}=${id} → ${value}`);
  res.json({ ok: true, scope, id, value });
});

// POST /api/customer-needs-human  body: {session_id, sport}
// Called by bot when customer clicks "Talk to a human" button OR auto-handoff fires.
app.post('/api/customer-needs-human', botRateLimit(60), requireBot, (req, res) => {
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
app.post('/api/human-message', requireAgent, (req, res) => {
  const { session_id, text, sport } = req.body || {};
  if (!session_id || !text) return res.status(400).json({ ok: false, error: 'session_id + text required' });
  // v3.0: agent_name comes from session (auth'd), not request body — prevents impersonation
  const msg = {
    id: ++pendingReplyId,
    text: String(text).slice(0, 4000),
    agent_name: String(req.agent.agent_name || 'Support'),
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
  audit(req, 'send_reply', `${sport}:${session_id}`, null, msg.text.slice(0,200));
  console.log(`[human-msg] sport=${sport} session=${session_id} agent=${msg.agent_name} text="${msg.text.slice(0,80)}"`);
  res.json({ ok: true, id: msg.id });
});

// GET /api/poll-replies?session_id=&since= — returns undelivered replies for that session.
// Called by bot's chat widget on a 2s loop. `since` is the last-seen reply id.
app.get('/api/poll-replies', requireBot, (req, res) => {
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
app.get('/api/notifications', requireAgent, (req, res) => {
  const since = parseInt(req.query.since || '0', 10) || 0;
  const fresh = notifications.filter(n => n.id > since);
  const unreadCount = notifications.filter(n => n.status === 'unread').length;
  res.json({ notifications: fresh, unread_count: unreadCount });
});

// POST /api/notifications/ack  body: {ids:[...]}
app.post('/api/notifications/ack', requireAgent, (req, res) => {
  const ids = (req.body && req.body.ids) || [];
  const idSet = new Set(ids.map(Number));
  let acked = 0;
  for (const n of notifications) {
    if (idSet.has(n.id) && n.status === 'unread') { n.status = 'read'; acked++; }
  }
  if (acked) saveStateDebounced();
  if (acked) audit(req, 'notif_ack', String((req.body && req.body.id) || ''), null, 'acked');
  res.json({ ok: true, acked });
});

// /login is the public login page — must be served before the auth gate on /
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Static assets (login.html stylesheet, JS, etc.)
// index:false so a bare GET / does NOT auto-serve index.html and bypass the
// auth gate below — the dashboard must only be served to an authenticated session.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Root: serve dashboard if authed, otherwise redirect to /login
app.get('/', (req, res) => {
  if (!getSession(req)) {
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[logs] listening on :${PORT} (max_entries=${MAX_ENTRIES})`);
  if (users.size > 0) console.log(`[auth] multi-user auth ENABLED (${users.size} seeded accounts)`);
  else if (DASHBOARD_PASSWORD) console.log('[auth] legacy shared-password auth ENABLED');
  else console.warn('[auth] WARNING: no AGENT_USERS and no DASHBOARD_PASSWORD — dashboard login will reject all requests');
  if (BOT_AUTH_TOKEN) console.log('[auth] bot auth ENABLED (Bearer token required on bot-facing endpoints)');
  else console.warn('[auth] WARNING: BOT_AUTH_TOKEN not set — bot-facing endpoints OPEN');
});
