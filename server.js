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

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_ENTRIES = parseInt(process.env.MAX_ENTRIES || '5000', 10);
const ADMIN_KEY = process.env.ADMIN_KEY || '';

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const logs = [];
let totalReceived = 0;
const startTime = new Date();

function pushLog(entry) {
  logs.push(entry);
  totalReceived += 1;
  while (logs.length > MAX_ENTRIES) logs.shift();
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
      meta: String(b.meta || '')
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
  res.json({
    status: 'running',
    version: '1.0.0',
    started_at: startTime.toISOString(),
    uptime_sec: Math.floor((Date.now() - startTime.getTime()) / 1000),
    total_received: totalReceived,
    in_buffer: logs.length,
    max_entries: MAX_ENTRIES
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

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[logs] listening on :${PORT} (max_entries=${MAX_ENTRIES})`);
});
