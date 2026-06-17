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
  sess.last_seen = Date.now();   // presence: any authed request keeps the agent "live"
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
  global: { tennis: 'on', padel: 'on', pickleball: 'on', badminton: 'on', squash: 'on' },  // DEFAULT: ON
  perCustomer: {}  // empty by default — every new session inherits global=on
};
const assignments = {}; // session_id -> { agent_id, agent_name, by, at } (transfer/claim)
// v5 conversation lifecycle: tracks closed state + the last human agent who
// handled each session, so a returning customer can be routed back to the
// same agent (or reassigned to a different one when that agent is offline).
// session_id -> { closed, closedAt, closedBy, lastAgentId, lastAgentName, lastReconnectAt }
const convMeta = {};
const pendingReplies = {};
const notifications = [];
let pendingReplyId = 0;
let notificationId = 0;

// ----- Agent availability (used for reconnect routing) -----
// "Online" = the agent has at least one non-expired dashboard session.
// Reconnect routing is env-tunable:
//   RECONNECT_RETURN_TO_SAME_AGENT (default 'on')  — if the previous agent is
//        online, route the returning customer straight back to them.
//   RECONNECT_AUTO_ASSIGN_FALLBACK (default 'off') — if the previous agent is
//        offline, auto-assign to the least-loaded other online agent instead of
//        dropping the chat into the shared Unclaimed queue.
const RECONNECT_RETURN_TO_SAME_AGENT = (process.env.RECONNECT_RETURN_TO_SAME_AGENT || 'on') !== 'off';
const RECONNECT_AUTO_ASSIGN_FALLBACK = (process.env.RECONNECT_AUTO_ASSIGN_FALLBACK || 'off') === 'on';
// An agent counts as "live right now" only if their dashboard made an
// authenticated request within this window. The console polls every few
// seconds, so an open tab stays live and a closed one drops off after the
// window. Tunable via PRESENCE_WINDOW_SEC (default 120s).
const PRESENCE_WINDOW_MS = (parseInt(process.env.PRESENCE_WINDOW_SEC || '120', 10) || 120) * 1000;

// Set of agent ids who are online AND active within the presence window.
function onlineAgentIds() {
  const now = Date.now();
  const ids = new Set();
  for (const s of sessions.values()) {
    if (s && s.expires_at > now && s.id && (now - (s.last_seen || 0) < PRESENCE_WINDOW_MS)) {
      ids.add(String(s.id).toLowerCase());
    }
  }
  return ids;
}
function isAgentOnline(id) {
  if (!id) return false;
  return onlineAgentIds().has(String(id).toLowerCase());
}
// Pick the least-loaded online agent other than `excludeId` (by current
// assignment count). Returns the user object, or null if none available.
function pickAvailableAgent(excludeId) {
  const online = onlineAgentIds();
  if (excludeId) online.delete(String(excludeId).toLowerCase());
  if (!online.size) return null;
  const load = {};
  for (const a of Object.values(assignments)) {
    const k = String(a.agent_id || '').toLowerCase();
    if (k) load[k] = (load[k] || 0) + 1;
  }
  let best = null, bestScore = Infinity;
  for (const id of online) {
    const u = findUser(id);
    if (!u) continue;                      // skip master-password sessions with no user record
    const score = load[id] || 0;
    if (score < bestScore) { bestScore = score; best = u; }
  }
  return best;
}

// ===== Working hours (support availability) =====
// Render dynos run in UTC — never use new Date().getHours() directly.
// All env-configurable:
//   WORKING_TZ           — IANA timezone the support team works in (default Asia/Kolkata)
//   WORKING_HOURS_START  — first working hour, inclusive, 0-23 (default 10 → 10:00)
//   WORKING_HOURS_END    — end hour, exclusive, 1-24 (default 19 → up to 18:59)
//   WORKING_DAYS         — comma list, 0=Sun..6=Sat (default '1,2,3,4,5,6' = Mon-Sat)
//   AFTER_HOURS_MESSAGE  — what the customer sees when requesting a human off-hours
const WORKING_TZ = process.env.WORKING_TZ || 'Asia/Kolkata';
const WORKING_HOURS_START = parseInt(process.env.WORKING_HOURS_START || '10', 10);
const WORKING_HOURS_END = parseInt(process.env.WORKING_HOURS_END || '19', 10);
const WORKING_DAYS = (process.env.WORKING_DAYS || '1,2,3,4,5,6').split(',').map(Number);
const AFTER_HOURS_MESSAGE = process.env.AFTER_HOURS_MESSAGE ||
  `Our support team is currently offline — we're available ${String(WORKING_HOURS_START).padStart(2, '0')}:00 to ${String(WORKING_HOURS_END).padStart(2, '0')}:00 IST, Monday to Saturday. ` +
  `Please leave your message here and the team will get back to you as soon as we're online.`;

// Returns { day: 0-6, hour: 0-23 } for `date` in the support team's timezone.
function _tzNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WORKING_TZ, hourCycle: 'h23', weekday: 'short', hour: 'numeric'
  }).formatToParts(date);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[get('weekday')], hour: parseInt(get('hour'), 10) };
}

function isWorkingHours(date = new Date()) {
  const { day, hour } = _tzNow(date);
  return WORKING_DAYS.includes(day) && hour >= WORKING_HOURS_START && hour < WORKING_HOURS_END;
}

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
      // Agent assignments (transfer/claim) — restore
      if (s.assignments && typeof s.assignments === 'object') {
        Object.assign(assignments, s.assignments);
      }
      // Conversation lifecycle (closed flag + last agent) — restore
      if (s.convMeta && typeof s.convMeta === 'object') {
        Object.assign(convMeta, s.convMeta);
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
        assignments,
        convMeta,
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

// ----- Rewrite the whole logs file from the in-memory array (used after a purge) -----
function rewriteLogsFile() {
  try {
    const tmp = LOGS_FILE + '.tmp';
    fs.writeFileSync(tmp, logs.map(e => JSON.stringify(e)).join('\n') + (logs.length ? '\n' : ''));
    fs.renameSync(tmp, LOGS_FILE);
  } catch (e) { console.warn('[persist] rewrite logs failed:', e.message); }
}

loadFromDisk();

// ============================================================
// Canned replies (v4.3) — disk-backed, admin-editable
// ============================================================
// Agents pull these into the reply box via inline autocomplete + the ⌘/ palette.
// Seeded from DEFAULT_CANNED on first boot, then persisted to canned.json so admin
// edits survive restarts (and redeploys when a Render disk is mounted at DATA_DIR).
const CANNED_FILE = path.join(DATA_DIR, 'canned.json');
const DEFAULT_CANNED = [
  // Greeting & conversation flow
  { category: 'Greeting', label: 'Opening', triggers: ['open', 'opening', 'hi', 'hello', 'welcome', 'greet'], body: `Welcome to Tennisoutlet. How may I help you?` },
  { category: 'Greeting', label: 'Additional help', triggers: ['additional', 'anythingelse', 'more', 'else'], body: `Is there anything else I can assist you with?` },
  { category: 'Greeting', label: 'Closing — great day', triggers: ['close', 'closing', 'bye', 'day', 'thanksday'], body: `Thank you for contacting Tennisoutlet. Have a great day!` },
  { category: 'Greeting', label: 'Closing — great weekend', triggers: ['weekend', 'closeweekend', 'byeweekend'], body: `Thank you for contacting Tennisoutlet. Have a great weekend!` },
  { category: 'Greeting', label: 'Hold', triggers: ['hold', 'wait', 'moment'], body: `Please be here for a moment, will get back to you with required details.` },
  { category: 'Greeting', label: 'Retrieve hold', triggers: ['retrieve', 'unhold', 'thankshold', 'back'], body: `Thank you for being here.` },
  // General
  { category: 'General', label: 'General terms', triggers: ['absolutely', 'sure', 'assist', 'happy'], body: `Absolutely! I'll be happy to assist you with that.` },
  { category: 'General', label: 'Particular issue feedback', triggers: ['issuefeedback', 'noted', 'escalate'], body: `Noted, I'll pass your feedback to the relevant team and ensure it is resolved at the earliest.` },
  { category: 'General', label: 'General feedback', triggers: ['feedback', 'appreciate', 'improve'], body: `Your feedback is highly appreciated and will help us improve our services.` },
  { category: 'General', label: 'Apology', triggers: ['apology', 'apologize', 'sorry', 'inconvenience'], body: `I'm genuinely sorry for the inconvenience you've experienced, and I'm here to make things right for you.` },
  // Product
  { category: 'Product', label: 'Product inquiry', triggers: ['product', 'inquiry', 'specify', 'whichproduct'], body: `Could you specify the product you're interested in?` },
  { category: 'Product', label: 'Product authenticity', triggers: ['authentic', 'authenticity', 'genuine', 'original', 'fake'], body: `All our products are 100% authentic and sourced directly from the brand or their authorized distributors.` },
  { category: 'Product', label: 'Warranty', triggers: ['warranty', 'warr', 'guarantee'], body: `Most of the products that we sell are covered under our unique WARRANTY PROMISE policy. For more details visit - https://tennisoutlet.in/warranty-promise` },
  { category: 'Product', label: 'Availability check', triggers: ['availability', 'available', 'instock', 'checkstock'], body: `Thank you for your inquiry. I'll promptly check the availability of the requested product and confirm you shortly.` },
  { category: 'Product', label: 'Out of stock', triggers: ['oos', 'outofstock', 'nostock', 'unavailable'], body: `Currently the product is not in stock however I will share the feedback with our concern team.` },
  // Orders & shipping
  { category: 'Orders', label: 'Order related — confirm number', triggers: ['order', 'orderrelated', 'registered', 'mobile'], body: `Sure, I'd be happy to help with your order. Is the number provided here your registered mobile number?` },
  { category: 'Orders', label: 'Request order details', triggers: ['orderdetails', 'orderid', 'reqorder', 'sharedetails'], body: `Sure, I'd be happy to help with your order. Can you please share your order ID or registered mobile number?` },
  { category: 'Orders', label: 'Delay in shipping', triggers: ['delay', 'shippingdelay', 'late'], body: `Sincere apologies for the delay, we will follow up with our delivery partner and ensure the product reach you at the earliest.` },
  { category: 'Orders', label: 'Shipping TAT — delivery window', triggers: ['tat', 'shippingtat', 'deliverytime', 'howlong'], body: `You can typically expect to receive your order within 2-5 business days, depending on the city.` },
  { category: 'Orders', label: 'Shipping TAT — dispatch', triggers: ['dispatch', 'processing', 'dispatchtat'], body: `Orders are processed and dispatched within 8 hours of receipt. Delivery times may vary between 1 to 3 business days depending on the city.` },
  { category: 'Orders', label: 'Tracking — request details', triggers: ['track', 'tracking', 'trackorder', 'wheremyorder'], body: `Could you please provide your registered mobile number or order ID for assistance in tracking your shipment.` },
  { category: 'Orders', label: 'Tracking — share details', triggers: ['trackingdetails', 'sharetracking', 'trackinginfo'], body: `Here's the tracking information for your order. Alternatively, you can also view it by logging into your account.` },
  { category: 'Orders', label: 'Change address — ask', triggers: ['address', 'changeaddress', 'newaddress', 'updateaddress'], body: `Could you please provide the new shipping address you want to change to?` },
  { category: 'Orders', label: 'Change address — done', triggers: ['addressupdated', 'addressdone'], body: `Thanks! Your shipping address has been updated.` },
  // Payments
  { category: 'Payments', label: 'Payment methods', triggers: ['payment', 'pay', 'methods', 'upi', 'cod', 'card'], body: `We accept multiple payment methods including credit/debit cards, net banking, UPI, EMI and cash on delivery.` },
  { category: 'Payments', label: 'EMI', triggers: ['emi', 'installment'], body: `We're in the process of enabling the EMI payment option, which is anticipated to be live within a week.` },
  // Returns & refunds
  { category: 'Returns', label: 'Return policy', triggers: ['returnpolicy', 'returns', 'return'], body: `We offer 30-day hassle-free return policy. Please visit https://tennisoutlet.in/return-cancellation-policy for details.\nOn Racquets, we offer a unique Play & Return policy, wherein you can order a racquet, play with it and return if it doesn't suit you. For more details visit https://tennisoutlet.in/play-return-program` },
  { category: 'Returns', label: 'Return reason', triggers: ['returnreason', 'reason', 'whyreturn'], body: `Could you kindly specify the reason for your return?` },
  { category: 'Returns', label: 'Return & exchange', triggers: ['exchange', 'returnexchange', 'unused', 'tags'], body: `You can return or exchange a product if it is in an unused condition with all stickers and tags intact. For more info please refer https://tennisoutlet.in/return-cancellation-policy` },
  { category: 'Returns', label: 'Play & Return', triggers: ['play', 'playreturn', 'tryracquet', 'demo'], body: `We provide a hassle-free play and return policy, allowing you to try out the racquet and return it within 5 days if needed. For more details, please visit: https://tennisoutlet.in/play-return-program` },
  { category: 'Returns', label: 'Refund', triggers: ['refund', 'money', 'wallet', 'creditback'], body: `Refunds are processed within 48 hours after receiving the product. However, the banks may take up to 5 business days to credit into your account. If you opt to receive the refund in your TO wallet, it is credited instantly.` },
  // Promotions
  { category: 'Promotions', label: 'First-time discount', triggers: ['promo', 'discount', 'offer', 'firsttime'], body: `We're currently offering a 15% discount on first-time purchases, with savings of up to 500/- RS.` },
  { category: 'Promotions', label: 'Coupon email', triggers: ['coupon', 'couponemail', 'flat5', 'exclusive'], body: `Dear Sir,\nGreetings from Tennisoutlet.in!\nWe're excited to extend an exclusive flat 5% discount on your total cart value without any capped amount, simply enter the coupon code "XXXXX" at checkout to redeem your discount today, which is exclusively made for you.\nAt TennisOutlet.in, we're dedicated to providing you with top-quality tennis gear and accessories to enhance your game.\nShould you have any questions or require assistance, our dedicated customer support team is here to help. Feel free to reach out to us at any time.` },
];
let canned = [];
let cannedSeq = 0;
function normTriggers(t) {
  const arr = Array.isArray(t) ? t : String(t || '').split(',');
  return Array.from(new Set(
    arr.map(s => String(s).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')).filter(Boolean)
  )).slice(0, 24);
}
function sanitizeCanned(c) {
  return {
    id: String(c.id),
    category: String(c.category || 'General').trim().slice(0, 40) || 'General',
    label: String(c.label || '').trim().slice(0, 80),
    triggers: normTriggers(c.triggers),
    body: String(c.body || '').slice(0, 8000)
  };
}
let cannedSaveTimer = null;
function saveCannedNow() {
  try {
    const tmp = CANNED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(canned, null, 2));
    fs.renameSync(tmp, CANNED_FILE);
  } catch (e) { console.warn('[canned] save failed:', e.message); }
}
function saveCannedDebounced() {
  if (cannedSaveTimer) clearTimeout(cannedSaveTimer);
  cannedSaveTimer = setTimeout(saveCannedNow, 300);
}
function loadCanned() {
  if (fs.existsSync(CANNED_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(CANNED_FILE, 'utf8'));
      if (Array.isArray(arr) && arr.length) {
        canned = arr.map(sanitizeCanned).filter(c => c.label && c.body);
        for (const c of canned) {
          const n = parseInt(String(c.id).replace(/\D/g, ''), 10);
          if (n > cannedSeq) cannedSeq = n;
        }
        console.log(`[canned] loaded ${canned.length} canned replies from disk`);
        return;
      }
    } catch (e) { console.warn('[canned] load failed, reseeding:', e.message); }
  }
  canned = DEFAULT_CANNED.map(c => sanitizeCanned(Object.assign({ id: 'c' + (++cannedSeq) }, c)));
  saveCannedNow();
  console.log(`[canned] seeded ${canned.length} default canned replies`);
}
loadCanned();

// ============================================================
// File attachments (v4.4) — disk-backed uploads
// ============================================================
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}
const UPLOADS_META_FILE = path.join(DATA_DIR, 'uploads.json');
let uploadsMeta = {};
try { if (fs.existsSync(UPLOADS_META_FILE)) uploadsMeta = JSON.parse(fs.readFileSync(UPLOADS_META_FILE, 'utf8')) || {}; }
catch (e) { uploadsMeta = {}; console.warn('[upload] meta load failed:', e.message); }
function saveUploadsMeta() {
  // Synchronous: uploads are infrequent and losing the id->name/type map orphans files.
  try { const t = UPLOADS_META_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(uploadsMeta)); fs.renameSync(t, UPLOADS_META_FILE); }
  catch (e) { console.warn('[upload] meta save failed:', e.message); }
}
function safeName(s) {
  return String(s || 'file').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
}
// Types we are willing to render inline in a browser. Everything else downloads.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'application/pdf']);
function safeServeType(t) {
  t = String(t || '').toLowerCase().split(';')[0].trim();
  // Never serve active/HTML/SVG content with its own type (XSS risk) — force download.
  if (t === 'text/html' || t === 'application/xhtml+xml' || t === 'image/svg+xml' || t.includes('javascript') || t.includes('ecmascript')) return 'application/octet-stream';
  return t || 'application/octet-stream';
}

// ===== Ops Monitor agent (admin-only daily health + LLM-cost watchdog) =====
// Separate module (ops-monitor.js). Mounted here so it shares admin auth + the
// in-memory logs, and stays awake to run its daily check.
try {
  const createOpsMonitor = require('./ops-monitor');
  const opsMonitor = createOpsMonitor({ getLogs: () => logs, requireAdmin, dataDir: DATA_DIR });
  app.use('/api/ops', opsMonitor.router);
  opsMonitor.start();
} catch (e) {
  console.warn('[ops-monitor] failed to start:', e.message);
}

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

// Classify a session id as automated test/QA/dev traffic (not a real customer chat).
// Production chat-widget sessions look like c_<base36>_<rand> (underscores, no hyphens).
// Anything that isn't that shape — qa-*, final-*, smoke-*, verify-*, ip:*, debug, etc. —
// is treated as synthetic. Empty/unknown session ids are left ALONE (could be real).
function isTestSession(sid) {
  sid = sid || '';
  if (!sid) return false;
  if (sid === 'debug') return true;
  if (/^ip:/i.test(sid)) return true;
  if (/^c_[a-z0-9]+(_[a-z0-9]+)*$/.test(sid)) return false;
  return true;
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
  // Auth resolution order (v3.1):
  //  1. Seeded/created user account (AGENT_USERS) — keeps the user's own role.
  //  2. Shared DASHBOARD_PASSWORD — master key, grants ADMIN so the owner is
  //     never locked out of /admin even after named accounts are seeded.
  //     (Previously the shared password was only honoured when NO users existed,
  //     and it granted 'agent' — so the admin panel was unreachable.)
  let sess = null;
  const u = findUser(loginId);
  if (u && safeEqStr(hashPw(u.salt, String(password)), u.hash)) {
    sess = { agent_name: u.name, id: u.id, role: u.role, expires_at: now + SESSION_TTL_MS };
  } else if (DASHBOARD_PASSWORD && safeEqStr(String(password), DASHBOARD_PASSWORD)) {
    const fid = (loginId || 'admin').toLowerCase().slice(0, 40);
    sess = { agent_name: (loginId || 'Admin').slice(0, 60), id: fid, role: 'admin', expires_at: now + SESSION_TTL_MS };
  } else if (users.size > 0 || DASHBOARD_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  } else {
    return res.status(500).json({ ok: false, error: 'server_not_configured' });
  }
  const sid = newSessionId();
  sess.last_seen = now;   // presence: count as live immediately on login
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
// ===== Canned replies API (v4.3) =====
// Reading is agent-level (any signed-in agent uses them in the reply box).
// Create / update / delete are admin-only and audit-logged.
app.get('/api/canned', requireAgent, (req, res) => {
  res.json({ ok: true, canned });
});
app.post('/api/canned', requireAdmin, (req, res) => {
  const b = req.body || {};
  const c = sanitizeCanned({ id: 'c' + (++cannedSeq), category: b.category, label: b.label, triggers: b.triggers, body: b.body });
  if (!c.label || !c.body) return res.status(400).json({ ok: false, error: 'label_and_body_required' });
  canned.push(c);
  saveCannedDebounced();
  audit(req, 'canned_create', c.id, null, { label: c.label, category: c.category });
  res.json({ ok: true, canned: c });
});
app.put('/api/canned/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '');
  const idx = canned.findIndex(c => c.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'not_found' });
  const b = req.body || {};
  const before = canned[idx];
  const updated = sanitizeCanned({
    id,
    category: b.category !== undefined ? b.category : before.category,
    label: b.label !== undefined ? b.label : before.label,
    triggers: b.triggers !== undefined ? b.triggers : before.triggers,
    body: b.body !== undefined ? b.body : before.body
  });
  if (!updated.label || !updated.body) return res.status(400).json({ ok: false, error: 'label_and_body_required' });
  canned[idx] = updated;
  saveCannedDebounced();
  audit(req, 'canned_update', id, { label: before.label }, { label: updated.label });
  res.json({ ok: true, canned: updated });
});
app.delete('/api/canned/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '');
  const idx = canned.findIndex(c => c.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'not_found' });
  const [removed] = canned.splice(idx, 1);
  saveCannedDebounced();
  audit(req, 'canned_delete', id, { label: removed.label }, null);
  res.json({ ok: true });
});

// ===== File attachments API (v4.4) =====
// Upload is agent-only; the raw body is parsed just for this route (no new deps).
app.post('/api/upload', requireAgent, express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
  try {
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ ok: false, error: 'empty_file' });
    if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'too_large' });
    const name = safeName(decodeURIComponent(req.headers['x-filename'] || 'file'));
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(UPLOAD_DIR, id), buf);
    uploadsMeta[id] = { name, type, size: buf.length, at: new Date().toISOString(), by: req.agent.agent_name || '' };
    saveUploadsMeta();
    audit(req, 'upload', id, null, { name, type, size: buf.length });
    res.json({ ok: true, id, name, type, size: buf.length, url: '/u/' + id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
// Public attachment serving — customers open these links, so NO auth gate here.
app.get('/u/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/[^a-f0-9]/g, '');
  const meta = uploadsMeta[id];
  const file = path.join(UPLOAD_DIR, id);
  if (!id || !meta || !fs.existsSync(file)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', safeServeType(meta.type));
  const disp = INLINE_TYPES.has(String(meta.type || '').toLowerCase()) ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', disp + '; filename="' + safeName(meta.name).replace(/"/g, '') + '"');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
});

// ===== Agent directory + transfer / claim (v4.4) =====
// Any signed-in agent can read the directory (for the transfer picker).
app.get('/api/agents', requireAgent, (req, res) => {
  const list = Array.from(users.values()).map(u => ({ id: u.id, name: u.name, role: u.role }));
  if (!list.length && req.agent) list.push({ id: req.agent.id || 'me', name: req.agent.agent_name || 'Me', role: req.agent.role || 'agent' });
  res.json({ ok: true, agents: list });
});
// Remember who last handled a session + clear any closed flag (an active
// assignment means the conversation is open again).
function recordAssignment(session_id, agent_id, agent_name) {
  const m = convMeta[session_id] || (convMeta[session_id] = {});
  m.lastAgentId = agent_id || '';
  m.lastAgentName = agent_name || 'Agent';
  m.closed = false;
  m.closedAt = null;
  m.closedBy = null;
}

// Claim a conversation for yourself (used by Take over) — assigns + pauses AI.
app.post('/api/claim', requireAgent, (req, res) => {
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ ok: false, error: 'session_id required' });
  assignments[session_id] = { agent_id: req.agent.id || '', agent_name: req.agent.agent_name || 'Agent', by: req.agent.agent_name || 'Agent', at: new Date().toISOString() };
  aiState.perCustomer[session_id] = 'off';
  recordAssignment(session_id, req.agent.id || '', req.agent.agent_name || 'Agent');
  saveStateDebounced();
  audit(req, 'claim', session_id, null, { agent: req.agent.agent_name });
  res.json({ ok: true });
});
// Transfer a conversation to a different human agent.
app.post('/api/transfer', requireAgent, (req, res) => {
  const { session_id, to_agent_id, sport, note } = req.body || {};
  if (!session_id || !to_agent_id) return res.status(400).json({ ok: false, error: 'session_id_and_to_agent_id_required' });
  const target = findUser(to_agent_id);
  if (!target) return res.status(404).json({ ok: false, error: 'agent_not_found' });
  const from = req.agent.agent_name || 'Agent';
  assignments[session_id] = { agent_id: target.id, agent_name: target.name, by: from, at: new Date().toISOString() };
  aiState.perCustomer[session_id] = 'off';  // human is in control after a transfer
  recordAssignment(session_id, target.id, target.name);
  const noteText = '🔁 Chat transferred from ' + from + ' to ' + target.name + (note ? (' — ' + String(note).slice(0, 300)) : '');
  pushLog({
    id: totalReceived + 1, received_at: new Date().toISOString(), timestamp: new Date().toISOString(),
    sport: String(sport || 'unknown').toLowerCase(), session_id,
    user_query: '', ai_response: noteText, intent: 'transfer', endpoint: '/api/transfer',
    source: 'system', agent_name: from, meta: ''
  });
  const notif = {
    id: ++notificationId, session_id, sport: String(sport || 'unknown').toLowerCase(),
    type: 'transfer', to_agent_id: target.id, to_agent_name: target.name, from_agent_name: from,
    timestamp: new Date().toISOString(), status: 'unread'
  };
  notifications.push(notif);
  while (notifications.length > 500) notifications.shift();
  saveStateDebounced();
  audit(req, 'transfer', session_id, null, { to: target.name, by: from });
  console.log(`[transfer] ${session_id} ${from} -> ${target.name}`);
  res.json({ ok: true, to: { id: target.id, name: target.name } });
});

// Mark every still-open human-request notification for a session as read.
// Used when a chat is closed so a stale "waiting" alert doesn't keep the
// conversation looking unclaimed.
function ackHumanNotifications(session_id) {
  let acked = 0;
  for (const n of notifications) {
    if (n.session_id === session_id && n.status === 'unread' &&
        ['talk_to_human', 'auto_handoff', 'after_hours_request', 'reconnect', 'reconnect_assigned'].includes(n.type)) {
      n.status = 'read';
      acked++;
    }
  }
  return acked;
}

// Close a conversation (server-authoritative). Frees the assignment, hands AI
// back on, clears the waiting alert, and remembers the last agent so a
// returning customer can be routed appropriately.
app.post('/api/close', requireAgent, (req, res) => {
  const { session_id, sport } = req.body || {};
  if (!session_id) return res.status(400).json({ ok: false, error: 'session_id required' });
  const prev = assignments[session_id];
  const m = convMeta[session_id] || (convMeta[session_id] = {});
  if (prev) { m.lastAgentId = prev.agent_id || ''; m.lastAgentName = prev.agent_name || 'Agent'; }
  m.closed = true;
  m.closedAt = new Date().toISOString();
  m.closedBy = req.agent.agent_name || 'Agent';
  delete assignments[session_id];           // free it
  aiState.perCustomer[session_id] = 'on';    // AI resumes for this customer
  ackHumanNotifications(session_id);          // clear the "waiting" alert
  pushLog({
    id: totalReceived + 1, received_at: new Date().toISOString(), timestamp: new Date().toISOString(),
    sport: String(sport || 'unknown').toLowerCase(), session_id,
    user_query: '', ai_response: '✓ Conversation closed by ' + (req.agent.agent_name || 'Agent') + '. AI resumed.',
    intent: 'close', endpoint: '/api/close', source: 'system', agent_name: req.agent.agent_name || 'Agent', meta: ''
  });
  saveStateDebounced();
  audit(req, 'close', session_id, null, { by: req.agent.agent_name });
  console.log(`[close] ${session_id} by ${req.agent.agent_name}`);
  res.json({ ok: true });
});

// Reopen a previously-closed conversation (operator-initiated).
app.post('/api/reopen', requireAgent, (req, res) => {
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ ok: false, error: 'session_id required' });
  const m = convMeta[session_id] || (convMeta[session_id] = {});
  m.closed = false;
  m.closedAt = null;
  m.closedBy = null;
  saveStateDebounced();
  audit(req, 'reopen', session_id, null, { by: req.agent.agent_name });
  res.json({ ok: true });
});

// ===== Test-data cleanup (v4.5, admin only) =====
// Summary drives the cleanup UI; purge is destructive and confirm-gated.
app.get('/api/logs/test-summary', requireAdmin, (req, res) => {
  let entries = 0; const sess = new Set();
  for (const l of logs) if (isTestSession(l.session_id)) { entries++; sess.add(l.session_id); }
  res.json({ ok: true, test_entries: entries, test_sessions: sess.size, total: logs.length, sample: Array.from(sess).slice(0, 30) });
});
app.post('/api/logs/purge-test', requireAdmin, (req, res) => {
  if (!req.body || req.body.confirm !== true) return res.status(400).json({ ok: false, error: 'confirm_required' });
  const before = logs.length;
  const kept = logs.filter(l => !isTestSession(l.session_id));
  const removed = before - kept.length;
  logs.length = 0; logs.push(...kept);
  rewriteLogsFile();
  audit(req, 'purge_test_logs', 'logs', { before }, { removed, remaining: logs.length });
  console.log(`[purge] removed ${removed} test entries (by ${req.agent.agent_name})`);
  res.json({ ok: true, removed, remaining: logs.length });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Audit log feed (admin only) — reads the append-only audit.jsonl, newest first.
app.get('/api/audit', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '300', 10) || 300, 2000);
  const entries = [];
  try {
    if (fs.existsSync(AUDIT_FILE)) {
      const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
      for (const l of lines.slice(-limit)) { try { entries.push(JSON.parse(l)); } catch (_) {} }
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
  entries.reverse();
  res.json({ ok: true, count: entries.length, file: AUDIT_FILE, entries });
});

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
  const working = isWorkingHours();
  res.json({
    ...resolveAiOn(sport, sessionId),
    working_hours: working,
    after_hours_message: working ? null : AFTER_HOURS_MESSAGE
  });
});

// GET /api/state-all — dashboard reads everything for the toggle UI
app.get('/api/state-all', requireAgent, (req, res) => {
  res.json({
    global: aiState.global,
    perCustomer: aiState.perCustomer,
    assignments,
    convMeta,                                                         // last agent + closed flags
    closed: Object.keys(convMeta).filter(sid => convMeta[sid] && convMeta[sid].closed),
    online_agents: Array.from(onlineAgentIds()),
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
    if (!['tennis', 'padel', 'pickleball', 'badminton', 'squash'].includes(id)) return res.status(400).json({ ok: false, error: 'bad sport' });
    aiState.global[id] = value;
  } else {
    aiState.perCustomer[id] = value;
    if (value === 'on') delete assignments[id];  // handing back to AI releases the human assignment
  }
  saveStateDebounced();
  audit(req, 'toggle_ai', `${scope}:${id}`, _before, value);
  console.log(`[toggle] ${scope}=${id} → ${value}`);
  res.json({ ok: true, scope, id, value });
});

// POST /api/customer-needs-human  body: {session_id, sport}
// Called by bot when customer clicks "Talk to a human" button OR auto-handoff fires.
// Handles RECONNECTS: a customer who was previously handled (and whose chat may
// have been closed) reappears here. We always reopen the conversation and route
// it so it can be picked up again — back to the same agent if they are online,
// otherwise freed to a different available agent / the Unclaimed queue.
app.post('/api/customer-needs-human', botRateLimit(60), requireBot, (req, res) => {
  const { session_id, sport, type } = req.body || {};
  if (!session_id) return res.status(400).json({ ok: false, error: 'session_id required' });
  const sportLc = String(sport || 'unknown').toLowerCase();

  const meta = convMeta[session_id] || (convMeta[session_id] = {});
  const wasClosed = !!meta.closed;
  // Who handled this customer before? Prefer a still-live assignment, fall back
  // to the remembered last agent (survives a close, which clears the assignment).
  const prevAgentId = (assignments[session_id] && assignments[session_id].agent_id) || meta.lastAgentId || '';
  const prevAgentName = (assignments[session_id] && assignments[session_id].agent_name) || meta.lastAgentName || '';
  const isReconnect = wasClosed || !!prevAgentId;

  // A returning customer must never stay hidden in "Closed" — reopen it so the
  // team sees them again (in Unclaimed, or under whoever it gets routed to).
  meta.closed = false;
  meta.closedAt = null;
  meta.closedBy = null;
  meta.lastReconnectAt = new Date().toISOString();

  // Outside working hours: do NOT flip AI off (nobody is around to reply — the
  // customer would be stranded with a silent chat until morning). Log a
  // notification so the team sees the missed request when they're back, keep
  // the AI in control, and hand the bot an after-hours message to relay.
  if (!isWorkingHours()) {
    const notif = {
      id: ++notificationId,
      session_id,
      sport: sportLc,
      type: 'after_hours_request',
      timestamp: new Date().toISOString(),
      status: 'unread'
    };
    notifications.push(notif);
    while (notifications.length > 500) notifications.shift();
    saveStateDebounced();
    console.log(`[notify] ${sportLc}/${session_id} requested human AFTER HOURS — handoff suppressed${isReconnect ? ' (reconnect)' : ''}`);
    return res.json({
      ok: true,
      handoff: false,
      working_hours: false,
      reconnect: isReconnect,
      message: AFTER_HOURS_MESSAGE,
      notification_id: notif.id
    });
  }

  // Working hours: hand the customer to a human (AI off for this session).
  aiState.perCustomer[session_id] = 'off';

  // ----- Reconnect routing -----
  let assignedTo = null;       // agent we routed to (null = left in Unclaimed)
  let notifType = String(type || 'talk_to_human');
  let systemNote = null;

  if (isReconnect) {
    const prevOnline = prevAgentId && isAgentOnline(prevAgentId);
    if (prevOnline && RECONNECT_RETURN_TO_SAME_AGENT) {
      // Same agent is around — route the customer straight back to them.
      const u = findUser(prevAgentId);
      assignedTo = { id: prevAgentId, name: (u && u.name) || prevAgentName || 'Agent' };
      assignments[session_id] = { agent_id: assignedTo.id, agent_name: assignedTo.name, by: 'reconnect', at: new Date().toISOString() };
      notifType = 'reconnect';
      systemNote = '↩ Customer reconnected — routed back to ' + assignedTo.name + '.';
    } else {
      // Previous agent is unavailable. CLOSE OUT their stale engagement so the
      // chat is no longer locked to them, then either auto-assign a different
      // available agent or drop it into the Unclaimed queue.
      if (assignments[session_id]) {
        systemNote = '⚠ Previous agent (' + (prevAgentName || 'unknown') + ') unavailable — prior session closed.';
        delete assignments[session_id];
      }
      const fallback = RECONNECT_AUTO_ASSIGN_FALLBACK ? pickAvailableAgent(prevAgentId) : null;
      if (fallback) {
        assignedTo = { id: fallback.id, name: fallback.name };
        assignments[session_id] = { agent_id: fallback.id, agent_name: fallback.name, by: 'reconnect-reassign', at: new Date().toISOString() };
        notifType = 'reconnect_assigned';
        systemNote = (systemNote ? systemNote + ' ' : '') + '↪ Reassigned to ' + fallback.name + (prevAgentName ? (' (was ' + prevAgentName + ').') : '.');
      } else {
        notifType = 'reconnect';
        systemNote = (systemNote ? systemNote + ' ' : '') + '📬 Returned to Unclaimed — waiting for an available agent.';
      }
    }
  }

  // Push the alert (carrying routing info for the dashboard).
  const notif = {
    id: ++notificationId,
    session_id,
    sport: sportLc,
    type: notifType,
    reconnect: isReconnect,
    to_agent_id: assignedTo ? assignedTo.id : null,
    to_agent_name: assignedTo ? assignedTo.name : null,
    from_agent_name: prevAgentName || null,
    timestamp: new Date().toISOString(),
    status: 'unread'
  };
  notifications.push(notif);
  while (notifications.length > 500) notifications.shift();

  // Leave a breadcrumb in the conversation thread so agents see what happened.
  if (systemNote) {
    pushLog({
      id: totalReceived + 1, received_at: new Date().toISOString(), timestamp: new Date().toISOString(),
      sport: sportLc, session_id, user_query: '', ai_response: systemNote,
      intent: 'reconnect', endpoint: '/api/customer-needs-human', source: 'system', agent_name: '', meta: ''
    });
  }

  saveStateDebounced();
  console.log(`[notify] ${sportLc}/${session_id} requested human (type=${notifType}${isReconnect ? ', reconnect' : ''}${assignedTo ? ', -> ' + assignedTo.name : ', -> unclaimed'})`);
  res.json({
    ok: true,
    handoff: true,
    working_hours: true,
    reconnect: isReconnect,
    reassigned_to: assignedTo ? assignedTo.name : null,
    status: assignedTo ? 'assigned' : 'unclaimed',
    notification_id: notif.id
  });
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
