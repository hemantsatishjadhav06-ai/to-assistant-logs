// Verifies the dashboard's conversation bucketing (statusFor) — the logic that
// decides what lands in "Unclaimed". Extracts the real functions from index.html.
import fs from 'node:fs';
const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

// Slice "function NAME(" up to the first line-start "}" that follows.
function grab(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find ' + name);
  const end = html.indexOf('\n}', start);
  if (end < 0) throw new Error('could not find end of ' + name);
  return html.slice(start, end + 2);
}
const factory = new Function('State', grab('aiStatusFor') + '\n' + grab('statusFor') + '\nreturn { statusFor, aiStatusFor };');

let pass = 0, fail = 0;
function kindOf(conv, state) { state.conversations = [conv]; const api = factory(state); return api.statusFor(conv).kind; }
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS ' + msg); } else { fail++; console.log('  ** FAIL ** ' + msg); } }

const base = sid => ({ session_id: sid, sport: 'tennis', has_human: false, last_human_agent: null });
const S = (over = {}) => ({ aiState: { global: { tennis: 'off', padel: 'on' }, perCustomer: {} }, assignments: {}, notifications: [], conversations: [], ...over });

console.log('\n[THE BUG] Tennis Global AI OFF, customer never asked for a human:');
ok(kindOf(base('c1'), S()) === 'ai', 'global-AI-off chat is NOT unclaimed (shows as AI handling)');

console.log('\n[Real handoff still works]');
ok(kindOf(base('c2'), S({ notifications: [{ session_id: 'c2', type: 'talk_to_human', status: 'unread' }] })) === 'unclaimed', 'customer who asked for a human -> unclaimed');
ok(kindOf(base('c3'), S({ aiState: { global: { tennis: 'off' }, perCustomer: { c3: 'off' } } })) === 'unclaimed', 'per-customer AI paused -> unclaimed');

console.log('\n[Claimed / human states]');
ok(kindOf(base('c4'), S({ assignments: { c4: { agent_id: 'a1', agent_name: 'Agent One' } } })) === 'claimed', 'assigned -> claimed');
ok(kindOf(Object.assign(base('c5'), { has_human: true, last_human_agent: 'Agent One' }), S({ aiState: { global: { tennis: 'off' }, perCustomer: { c5: 'off' } } })) === 'claimed', 'per-off + human replied -> claimed');

console.log('\n[Noise that must NOT create unclaimed]');
ok(kindOf(base('c6'), S({ notifications: [{ session_id: 'c6', type: 'transfer', status: 'unread' }] })) === 'ai', 'a transfer notification alone does not make it unclaimed');
ok(kindOf(Object.assign(base('c7'), { sport: 'padel' }), S()) === 'ai', 'normal AI chat (global on) -> ai');

console.log(`\n==== statusFor: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
