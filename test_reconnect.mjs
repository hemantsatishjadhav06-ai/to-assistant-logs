import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const sha = (salt, pw) => crypto.createHash('sha256').update(String(salt) + String(pw)).digest('hex');
const AGENT_USERS = JSON.stringify([
  { id: 'agent1', name: 'Agent One', role: 'agent', salt: 's1', hash: sha('s1', 'pass1') },
  { id: 'agent2', name: 'Agent Two', role: 'agent', salt: 's2', hash: sha('s2', 'pass2') },
]);
const BOT_TOKEN = 'bottoken123';
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  PASS ' + msg); } else { failed++; console.log('  ** FAIL ** ' + msg); } }

function boot(extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tolog-'));
  const port = 3900 + Math.floor(Math.random() * 80);
  const env = { ...process.env, PORT: String(port), LOGS_DATA_DIR: dataDir,
    AGENT_USERS, BOT_AUTH_TOKEN: BOT_TOKEN, DASHBOARD_PASSWORD: 'master',
    WORKING_HOURS_START: '0', WORKING_HOURS_END: '24', WORKING_DAYS: '0,1,2,3,4,5,6', ...extraEnv };
  const child = spawn('node', ['server.js'], { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  return { child, base: `http://127.0.0.1:${port}` };
}
async function waitReady(base) {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
}
async function login(base, id, password) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, password }) });
  const m = (r.headers.get('set-cookie') || '').match(/to_session=([^;]+)/);
  if (!m) throw new Error('login failed for ' + id + ': ' + (await r.text()));
  return 'to_session=' + m[1];
}
const aGet = (base, c, p) => fetch(base + p, { headers: { cookie: c } }).then(r => r.json());
const aPost = (base, c, p, b) => fetch(base + p, { method: 'POST', headers: { cookie: c, 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const bPost = (base, p, b) => fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + BOT_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

async function run() {
  console.log('\n=== BOOT 1: default (RECONNECT_AUTO_ASSIGN_FALLBACK off) ===');
  let { child, base } = boot({});
  await waitReady(base);
  let a1 = await login(base, 'agent1', 'pass1');
  let a2 = await login(base, 'agent2', 'pass2');
  const SID = 'c_alice';

  console.log('\n[1] First contact (no prior agent)');
  let r = await bPost(base, '/api/customer-needs-human', { session_id: SID, sport: 'tennis' });
  ok(r.ok && r.reconnect === false, 'first contact is not a reconnect');
  ok(r.status === 'unclaimed', 'first contact lands in Unclaimed');

  console.log('\n[2] Agent One claims');
  await aPost(base, a1, '/api/claim', { session_id: SID });
  let st = await aGet(base, a2, '/api/state-all');
  ok(st.assignments[SID] && st.assignments[SID].agent_id === 'agent1', 'assigned to agent1');
  ok(st.convMeta[SID] && st.convMeta[SID].lastAgentId === 'agent1', 'lastAgent recorded = agent1');

  console.log('\n[3] Agent One closes');
  r = await aPost(base, a1, '/api/close', { session_id: SID, sport: 'tennis' });
  st = await aGet(base, a2, '/api/state-all');
  ok(r.ok && !st.assignments[SID], 'close frees the assignment');
  ok(st.closed.includes(SID), 'state-all reports SID closed');
  ok(st.perCustomer[SID] === 'on', 'AI resumed on close');
  let notifs = (await aGet(base, a2, '/api/notifications?since=0')).notifications;
  ok(!notifs.some(n => n.session_id === SID && n.status === 'unread' && n.type !== 'transfer'), 'prior waiting alert acked on close');

  console.log('\n[4] CONTINUITY: prev agent ONLINE -> back to Agent One');
  r = await bPost(base, '/api/customer-needs-human', { session_id: SID, sport: 'tennis' });
  st = await aGet(base, a2, '/api/state-all');
  ok(r.reconnect === true, 'flagged as reconnect');
  ok(r.status === 'assigned' && r.reassigned_to === 'Agent One', 'routed back to Agent One');
  ok(st.assignments[SID] && st.assignments[SID].agent_id === 'agent1', 'assignment restored to agent1');
  ok(!st.closed.includes(SID), 'reopened');

  console.log('\n[5] ISSUE 2: close + prev agent OFFLINE -> UNCLAIMED');
  await aPost(base, a1, '/api/close', { session_id: SID, sport: 'tennis' });
  await aPost(base, a1, '/api/logout', {});
  r = await bPost(base, '/api/customer-needs-human', { session_id: SID, sport: 'tennis' });
  st = await aGet(base, a2, '/api/state-all');
  ok(r.reconnect === true, 'flagged as reconnect');
  ok(r.status === 'unclaimed', 'returned to Unclaimed (agent1 offline, fallback off)');
  ok(!st.assignments[SID], 'NOT locked to the offline agent');
  ok(!st.closed.includes(SID), 'no longer in Closed -> visible again');
  ok(st.perCustomer[SID] === 'off', 'AI paused -> needs an agent');
  notifs = (await aGet(base, a2, '/api/notifications?since=0')).notifications;
  ok(notifs.some(n => n.session_id === SID && n.status === 'unread' && n.type === 'reconnect'), 'fresh unread reconnect alert present');

  console.log('\n[6] A DIFFERENT agent claims the returning customer');
  await aPost(base, a2, '/api/claim', { session_id: SID });
  st = await aGet(base, a2, '/api/state-all');
  ok(st.assignments[SID] && st.assignments[SID].agent_id === 'agent2', 'agent2 (different) claimed it');
  child.kill();

  console.log('\n=== BOOT 2: RECONNECT_AUTO_ASSIGN_FALLBACK on ===');
  ({ child, base } = boot({ RECONNECT_AUTO_ASSIGN_FALLBACK: 'on' }));
  await waitReady(base);
  a1 = await login(base, 'agent1', 'pass1');
  a2 = await login(base, 'agent2', 'pass2');
  const SID2 = 'c_bob';

  console.log('\n[7] ISSUE 1: handled by Agent One, who goes offline; reconnect AUTO-ASSIGNS a different agent');
  await bPost(base, '/api/customer-needs-human', { session_id: SID2, sport: 'padel' });
  await aPost(base, a1, '/api/claim', { session_id: SID2 });
  await aPost(base, a1, '/api/close', { session_id: SID2, sport: 'padel' });
  await aPost(base, a1, '/api/logout', {});
  r = await bPost(base, '/api/customer-needs-human', { session_id: SID2, sport: 'padel' });
  st = await aGet(base, a2, '/api/state-all');
  ok(r.reconnect === true, 'flagged as reconnect');
  ok(r.status === 'assigned' && r.reassigned_to === 'Agent Two', 'auto-assigned to the different agent (Agent Two)');
  ok(st.assignments[SID2] && st.assignments[SID2].agent_id === 'agent2', 'assignment is agent2, not offline agent1');
  ok(!st.closed.includes(SID2), 'reopened');
  child.kill();

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(2); });
