// ops-monitor.js — the "Ops Monitor" agent.
//
// A self-contained daily health + cost watchdog for the 3 bots + the logs
// service. Runs INSIDE the logs service (so it is always awake and has access
// to the conversation logs + admin auth), but is logically a separate agent:
// its own module, its own scheduler, its own admin-only endpoints.
//
// What it does, once a day (and on demand):
//   • Render: pulls each service's latest deploy status + commit (git) and
//     whether the service is suspended.
//   • Liveness: pings each service over HTTPS and records status + latency.
//   • Errors: scans recent Render runtime logs for 5xx responses and error-level
//     lines, with samples.
//   • Cost: pulls REAL LLM spend from OpenRouter (total + daily/weekly/monthly)
//     and estimates a per-sport split from how many LLM-eligible turns each bot
//     handled.
//
// Endpoints (admin only — mounted under /api/ops by server.js):
//   GET  /api/ops/report  → latest stored report (computes one if none yet)
//   POST /api/ops/run     → force a fresh check now
//
// Config via env (all optional except the API keys for live data):
//   RENDER_API_KEY      — to read deploy status + runtime logs
//   RENDER_OWNER_ID     — owner/team id for the logs API (auto-discovered if unset)
//   OPENROUTER_API_KEY  — to read real LLM spend
//   OPS_SERVICES        — JSON override of the service map (see DEFAULT_SERVICES)
//   OPS_DAILY_HOUR_UTC  — hour of day (UTC) to run the daily check (default 6)

const express = require('express');
const fs = require('fs');
const path = require('path');

const DEFAULT_SERVICES = [
  { key: 'logs',       name: 'to-assistant-logs',       id: 'srv-d7srecbbc2fs73d1uou0', url: 'https://to-assistant-logs.onrender.com',       sport: null },
  { key: 'tennis',     name: 'to-assistant-tennis',     id: 'srv-d7p9ohbbc2fs739tgu50', url: 'https://to-assistant-tennis.onrender.com',     sport: 'tennis' },
  { key: 'padel',      name: 'to-assistant-padel',      id: 'srv-d7pa4apkh4rs73da9qig', url: 'https://to-assistant-padel.onrender.com',      sport: 'padel' },
  { key: 'pickleball', name: 'to-assistant-pickleball', id: 'srv-d7p9oi0g4nts73bctllg', url: 'https://to-assistant-pickleball.onrender.com', sport: 'pickleball' },
];

function createOpsMonitor(opts = {}) {
  const getLogs = typeof opts.getLogs === 'function' ? opts.getLogs : () => [];
  const requireAdmin = opts.requireAdmin || ((req, res, next) => next());
  const DATA_DIR = opts.dataDir || __dirname;
  const REPORT_FILE = path.join(DATA_DIR, 'ops_report.json');

  const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
  const DAILY_HOUR_UTC = parseInt(process.env.OPS_DAILY_HOUR_UTC || '6', 10);
  let OWNER_ID = process.env.RENDER_OWNER_ID || '';

  let SERVICES = DEFAULT_SERVICES;
  if (process.env.OPS_SERVICES) {
    try { SERVICES = JSON.parse(process.env.OPS_SERVICES); } catch (_) {}
  }

  let lastReport = null;
  let lastRunYmd = null;
  try {
    if (fs.existsSync(REPORT_FILE)) {
      lastReport = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    }
  } catch (_) {}

  // ---- small fetch helper with timeout (Node 18+/22 global fetch) ----
  async function tfetch(url, { headers = {}, timeout = 8000, method = 'GET' } = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    const start = Date.now();
    try {
      const r = await fetch(url, { method, headers, signal: ac.signal });
      const latency = Date.now() - start;
      let body = null;
      const txt = await r.text();
      try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
      return { ok: r.ok, status: r.status, body, latency };
    } catch (e) {
      return { ok: false, status: 0, error: String(e.name === 'AbortError' ? 'timeout' : (e.message || e)), latency: Date.now() - start };
    } finally {
      clearTimeout(t);
    }
  }

  const renderHeaders = () => ({ 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Accept': 'application/json' });

  async function discoverOwnerId() {
    if (OWNER_ID || !RENDER_API_KEY) return OWNER_ID;
    const r = await tfetch(`https://api.render.com/v1/services/${SERVICES[0].id}`, { headers: renderHeaders(), timeout: 8000 });
    if (r.ok && r.body && r.body.ownerId) OWNER_ID = r.body.ownerId;
    return OWNER_ID;
  }

  async function checkService(svc) {
    const out = { key: svc.key, name: svc.name, sport: svc.sport, url: svc.url };

    // 1) latest deploy (status + git commit)
    if (RENDER_API_KEY) {
      const dep = await tfetch(`https://api.render.com/v1/services/${svc.id}/deploys?limit=1`, { headers: renderHeaders(), timeout: 8000 });
      if (dep.ok && Array.isArray(dep.body) && dep.body[0]) {
        const d = dep.body[0].deploy || dep.body[0];
        out.deploy_status = d.status || 'unknown';
        out.deploy_at = d.finishedAt || d.createdAt || null;
        out.commit = d.commit ? { id: (d.commit.id || '').slice(0, 7), message: (d.commit.message || '').split('\n')[0].slice(0, 80) } : null;
      } else {
        out.deploy_status = 'unknown';
        out.deploy_error = dep.error || ('HTTP ' + dep.status);
      }
      // service suspended?
      const svcResp = await tfetch(`https://api.render.com/v1/services/${svc.id}`, { headers: renderHeaders(), timeout: 8000 });
      if (svcResp.ok && svcResp.body) out.suspended = svcResp.body.suspended || 'unknown';
    } else {
      out.deploy_status = 'no_render_key';
    }

    // 2) live ping
    const ping = await tfetch(svc.url + '/api/health', { timeout: 8000 }).then(r =>
      r.status ? r : tfetch(svc.url + '/', { timeout: 8000 })
    );
    out.ping_status = ping.status || 0;
    out.ping_ms = ping.latency;
    out.online = ping.status >= 200 && ping.status < 500;

    // 3) error scan from Render runtime logs (last ~100 lines)
    out.errors_5xx = 0; out.errors_level = 0; out.error_samples = [];
    if (RENDER_API_KEY && OWNER_ID) {
      const lr = await tfetch(`https://api.render.com/v1/logs?ownerId=${encodeURIComponent(OWNER_ID)}&resource=${svc.id}&limit=100`, { headers: renderHeaders(), timeout: 9000 });
      if (lr.ok && lr.body && Array.isArray(lr.body.logs)) {
        for (const entry of lr.body.logs) {
          const labels = {};
          (entry.labels || []).forEach(l => { labels[l.name] = l.value; });
          const code = parseInt(labels.statusCode || '0', 10);
          const level = (labels.level || '').toLowerCase();
          const isErr = code >= 500 || level === 'error' || /\b(exception|unhandled|ECONN|ETIMEDOUT|throw |fatal)\b/i.test(entry.message || '');
          if (code >= 500) out.errors_5xx++;
          if (level === 'error') out.errors_level++;
          if (isErr && out.error_samples.length < 5) {
            out.error_samples.push({ at: entry.timestamp || null, code: code || null, msg: String(entry.message || '').slice(0, 200) });
          }
        }
      } else if (lr.error || lr.status) {
        out.log_scan_note = lr.error || ('HTTP ' + lr.status);
      }
    }

    // overall health verdict
    out.healthy = (out.deploy_status === 'live' || out.deploy_status === 'no_render_key') && out.online && out.errors_5xx === 0;
    return out;
  }

  // LLM cost: real spend from OpenRouter + a per-sport split estimated from logs.
  async function getCost() {
    const cost = { source: 'openrouter', currency: 'USD' };
    if (OPENROUTER_API_KEY) {
      const key = await tfetch('https://openrouter.ai/api/v1/auth/key', { headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` }, timeout: 9000 });
      if (key.ok && key.body && key.body.data) {
        const d = key.body.data;
        cost.usage_total = d.usage ?? null;
        cost.usage_today = d.usage_daily ?? null;
        cost.usage_week = d.usage_weekly ?? null;
        cost.usage_month = d.usage_monthly ?? null;
        cost.limit = d.limit ?? null;
        cost.limit_remaining = d.limit_remaining ?? null;
      } else {
        cost.key_error = key.error || ('HTTP ' + key.status);
      }
      const cr = await tfetch('https://openrouter.ai/api/v1/credits', { headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` }, timeout: 9000 });
      if (cr.ok && cr.body && cr.body.data) {
        cost.account_credits = cr.body.data.total_credits ?? null;
        cost.account_usage = cr.body.data.total_usage ?? null;
        if (cost.account_credits != null && cost.account_usage != null) {
          cost.account_remaining = Math.max(0, cost.account_credits - cost.account_usage);
        }
      }
    } else {
      cost.key_error = 'OPENROUTER_API_KEY not set';
    }

    // per-sport split — estimate from LLM-eligible turns (exclude deterministic
    // short-circuits / ai-off holds that never call the model).
    const logs = getLogs() || [];
    const counts = { tennis: 0, padel: 0, pickleball: 0 };
    let llmTurns = 0;
    for (const l of logs) {
      if (l.source && l.source !== 'bot') continue;
      const intent = (l.intent || '');
      const deterministic = /short_circuit|ai_off_hold|warehouse|cross_store|cross_sport|support_contact|upgrade_program/.test(intent);
      if (deterministic) continue;
      if (!(l.user_query || '').trim()) continue;
      llmTurns++;
      if (counts[l.sport] != null) counts[l.sport]++;
    }
    cost.llm_turns_in_buffer = llmTurns;
    const totalCounted = counts.tennis + counts.padel + counts.pickleball;
    cost.per_sport_share = {};
    for (const sp of Object.keys(counts)) {
      const share = totalCounted ? counts[sp] / totalCounted : 0;
      cost.per_sport_share[sp] = {
        turns: counts[sp],
        pct: Math.round(share * 100),
        est_month_usd: (cost.usage_month != null) ? +(cost.usage_month * share).toFixed(2) : null,
      };
    }
    cost.per_sport_note = 'Per-sport $ is an estimate: OpenRouter bills one shared key, split here by share of LLM-eligible turns currently in the log buffer.';
    return cost;
  }

  async function runCheck() {
    await discoverOwnerId();
    const services = [];
    for (const svc of SERVICES) {
      try { services.push(await checkService(svc)); }
      catch (e) { services.push({ key: svc.key, name: svc.name, error: String(e.message || e) }); }
    }
    let cost = {};
    try { cost = await getCost(); } catch (e) { cost = { error: String(e.message || e) }; }

    const issues = [];
    for (const s of services) {
      if (s.deploy_status && !['live', 'no_render_key'].includes(s.deploy_status)) issues.push(`${s.name}: deploy ${s.deploy_status}`);
      if (s.online === false) issues.push(`${s.name}: not responding (ping ${s.ping_status || 'fail'})`);
      if (s.errors_5xx) issues.push(`${s.name}: ${s.errors_5xx} server errors (5xx) in recent logs`);
      if (s.suspended && s.suspended === 'suspended') issues.push(`${s.name}: SUSPENDED`);
    }

    const report = {
      generated_at: new Date().toISOString(),
      ok: issues.length === 0,
      issues,
      services,
      cost,
      config: { render_key: !!RENDER_API_KEY, openrouter_key: !!OPENROUTER_API_KEY, owner_id: !!OWNER_ID },
    };
    lastReport = report;
    try { fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2)); } catch (_) {}
    lastRunYmd = new Date().toISOString().slice(0, 10);
    console.log(`[ops-monitor] check done — ${issues.length} issue(s)${issues.length ? ': ' + issues.join('; ') : ''}`);
    return report;
  }

  // ---- daily scheduler: hourly tick, fire once/day at >= DAILY_HOUR_UTC ----
  function start() {
    // initial run shortly after boot so there's always a report
    setTimeout(() => { runCheck().catch(e => console.warn('[ops-monitor] initial run failed:', e.message)); }, 15000);
    setInterval(() => {
      const now = new Date();
      const ymd = now.toISOString().slice(0, 10);
      if (now.getUTCHours() >= DAILY_HOUR_UTC && lastRunYmd !== ymd) {
        runCheck().catch(e => console.warn('[ops-monitor] daily run failed:', e.message));
      }
    }, 60 * 60 * 1000).unref();
    console.log(`[ops-monitor] started — daily check at ${DAILY_HOUR_UTC}:00 UTC (render_key=${!!RENDER_API_KEY}, openrouter_key=${!!OPENROUTER_API_KEY})`);
  }

  // ---- routes (admin only) ----
  const router = express.Router();
  router.get('/report', requireAdmin, async (req, res) => {
    if (!lastReport) {
      try { lastReport = await runCheck(); } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
    }
    res.json({ ok: true, report: lastReport });
  });
  router.post('/run', requireAdmin, async (req, res) => {
    try { const r = await runCheck(); res.json({ ok: true, report: r }); }
    catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  return { router, start, runCheck, getLast: () => lastReport };
}

module.exports = createOpsMonitor;
