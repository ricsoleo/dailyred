// API test: runs the server (server/src/index.js) in wrangler's local runtime
// with a fresh database and a fake clock, and checks trainers, recovery codes,
// one battle per day, results, abandoned battles, streaks across days, battles
// that cross midnight and the hall of fame. Takes about 10 seconds; no ROM or
// browser needed.
import { startSite, ADMIN_TOKEN } from './lib.mjs';
import { dailySeed } from '../server/src/index.js';

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures++;
}

const site = await startSite();
let clock = '2026-10-11T10:00:00Z';
const at = (day, time = '10:00:00') => { clock = `${day}T${time}Z`; };

async function api(method, path, { body, code, admin } = {}) {
  const headers = { 'X-Test-Now': clock };
  if (code) headers.Authorization = `Bearer ${code}`;
  if (admin) headers['X-Admin-Token'] = admin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${site.url}/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
}

const join = (name) => api('POST', 'players', { body: { name } });
const me = (code) => api('GET', 'me', { code });
// Each page picks a run ID per battle; by default use one per trainer and day.
const runFor = (code, day) => `run-${code.slice(0, 5)}-${day}`;
const start = (code, day, run = runFor(code, day)) => api('POST', 'battles/start', { code, body: { day, run } });
const result = (code, day, won, run = runFor(code, day)) => api('POST', 'battles/result', { code, body: { day, won, run } });
const fame = () => api('GET', 'halloffame');
const line = (p) => `${p.wins}W ${p.losses}L, win streak ${p.winStreak} (best ${p.bestWinStreak}), day streak ${p.dayStreak}`;

try {
  const D1 = '2026-10-11', D2 = '2026-10-12', D3 = '2026-10-13', D4 = '2026-10-14', D5 = '2026-10-15', D6 = '2026-10-16', D7 = '2026-10-17';

  // --- Trainers ---------------------------------------------------------------
  at(D1);
  for (const bad of ['', 'A', 'x'.repeat(17), '<script>', 'a\u0000b']) {
    check((await join(bad)).status === 400, `rejects the name ${JSON.stringify(bad)}`);
  }
  const alice = await join('  Alice   Smith ');
  check(alice.status === 201 && alice.player.name === 'Alice Smith', `creates a trainer, tidying the name ("${alice.player?.name}")`);
  check(/^[0-9A-HJKMNP-TV-Z]{6}$/.test(alice.player.id), `trainer ID looks like ${alice.player.id}`);
  check(/^([0-9A-HJKMNP-TV-Z]{5}-){4}[0-9A-HJKMNP-TV-Z]{5}$/.test(alice.code), 'recovery code is 5 groups of 5');
  const A = alice.code;
  check((await join('Ŝtefano Ñ')).status === 201, 'accepts accented names');

  check((await me()).status === 401, 'GET /me without a code is refused');
  check((await me('AAAAA-AAAAA-AAAAA-AAAAA-AAAAA')).status === 401, 'an unknown code is refused');
  const typed = await me(A.toLowerCase().replace(/-/g, ' '));
  check(typed.status === 200 && typed.player.id === alice.player.id, 'a code typed in lowercase with spaces still works');
  check(!('token_hash' in typed.player) && !('code' in typed.player), 'the player record never includes secrets');
  check(typed.today.day === D1 && typed.today.seed === dailySeed(D1) && typed.today.status === 'open', `today is ${D1}, seed ${typed.today.seed}, open`);
  check(typed.today.nextDayAt === `${D2}T00:00:00.000Z`, 'next battle unlocks at midnight UTC');

  const renamed = await api('PATCH', 'me', { code: A, body: { name: 'Alice' } });
  check(renamed.status === 200 && renamed.player.name === 'Alice', 'a trainer can be renamed');

  // --- Day 1: a win -----------------------------------------------------------
  check((await result(A, D1, true)).status === 409, "a result without a started battle is refused");
  check((await start(A, D2)).status === 409, "starting another day's battle is refused");
  check((await start(A, D1, 'x')).status === 400, 'a start needs a run ID');
  const started = await start(A, D1);
  check(started.status === 200 && started.today.status === 'running', 'starting the battle: today counts as played');
  check((await start(A, D1)).status === 200, 'the same run can repeat its start (a lost response)');
  check((await start(A, D1, 'another-tab-run')).status === 409, 'a second battle the same day is refused');
  check((await result(A, D1, 'yes')).status === 400, 'a result must be true or false');
  check((await result(A, D1, true, 'another-tab-run')).status === 409, "another run can't send this battle's result");
  at(D1, '10:06:00');
  const won = await result(A, D1, true);
  check(won.status === 200 && won.today.status === 'won' && won.player.wins === 1 && won.player.winStreak === 1 && won.player.dayStreak === 1, `win recorded (${line(won.player)})`);
  check((await result(A, D1, true)).status === 409, 'the same result cannot be sent twice');
  check((await start(A, D1)).status === 409, 'no rematch after the result, even from the same run');

  let hof = await fame();
  check(hof.today.winners.length === 1 && hof.today.winners[0].id === alice.player.id && hof.today.winners[0].name === 'Alice', "Alice is in today's champions");
  check(hof.today.played === 1 && hof.today.won === 1, 'today: 1 of 1 won');
  check(hof.wins[0]?.id === alice.player.id && hof.wins[0].wins === 1, 'Alice leads Most wins');
  check(hof.streaks[0]?.id === alice.player.id && hof.streaks[0].streak === 1, 'Alice leads Win streaks');

  // --- Day 2: a loss, and Bob ----------------------------------------------------
  at(D2);
  const bob = await join('Bob');
  const B = bob.code;
  await start(A, D2);
  const lost = await result(A, D2, false);
  check(lost.player.wins === 1 && lost.player.losses === 1 && lost.player.winStreak === 0 && lost.player.dayStreak === 2 && lost.player.bestWinStreak === 1, `loss recorded (${line(lost.player)})`);
  await start(B, D2);
  at(D2, '11:00:00');
  await result(B, D2, true);

  // --- Day 3: Alice leaves mid-battle --------------------------------------------
  at(D3);
  await start(A, D3);
  at(D3, '11:30:00');
  check((await me(A)).today.status === 'running', 'a battle in progress is still running after 90 minutes');
  at(D3, '12:01:00');
  const abandoned = await me(A);
  check(abandoned.today.status === 'lost' && abandoned.player.losses === 2 && abandoned.player.dayStreak === 3, `no result within 2 hours: a loss (${line(abandoned.player)})`);
  check((await result(A, D3, true)).status === 409, 'a late win is refused');
  await start(B, D3);
  await result(B, D3, true);

  // Carol starts and vanishes; anyone loading the hall of fame settles it.
  const carol = await join('Carol');
  const C = carol.code;
  await start(C, D3);
  at(D3, '15:00:00');
  hof = await fame();
  check(hof.today.played === 3 && hof.today.won === 1, `abandoned battles are settled by the hall of fame (${hof.today.won} of ${hof.today.played})`);

  // --- Day 4 and 5: streaks ------------------------------------------------------
  at(D4);
  await start(B, D4);
  const bobDay4 = await result(B, D4, true);
  check(bobDay4.player.winStreak === 3 && bobDay4.player.bestWinStreak === 3, `three daily wins in a row (${line(bobDay4.player)})`);
  hof = await fame();
  check(hof.streaks[0]?.id === bob.player.id && hof.streaks[0].streak === 3, 'Bob leads Win streaks with 3');
  check(hof.wins.map((r) => r.id).join() === [bob.player.id, alice.player.id].join(), 'Most wins: Bob (3), then Alice (1)');

  at(D5);
  const alice5 = await me(A);
  check(alice5.player.winStreak === 0 && alice5.player.dayStreak === 0 && alice5.player.wins === 1 && alice5.player.losses === 2, `missing a day resets Alice's streaks (${line(alice5.player)})`);
  check((await fame()).streaks[0]?.streak === 3, "Bob's streak is still alive the next day");
  at(D6);
  hof = await fame();
  check(!hof.streaks.some((r) => r.id === bob.player.id), 'after a missed day Bob leaves Win streaks');
  check((await me(B)).player.bestWinStreak === 3, 'his best streak is kept');

  // --- A battle across midnight ---------------------------------------------------
  at(D6, '23:55:00');
  await start(C, D6);
  at(D7, '00:10:00');
  const late = await result(C, D6, true);
  check(late.status === 200 && late.player.wins === 1, 'a battle started before midnight can finish after it');
  check(late.today.day === D7 && late.today.status === 'open', "and the new day's battle is open");

  // Play pressed just before midnight: the battle can still start for yesterday.
  const erin = await join('Erin');
  at(D7, '00:20:00');
  check((await start(erin.code, D6)).status === 200, "up to 30 minutes after midnight, yesterday's battle can still start");
  const erinWin = await result(erin.code, D6, true);
  check(erinWin.status === 200 && erinWin.player.wins === 1, 'and its result counts');
  check((await start(erin.code, D7)).status === 200, "then today's battle is open as usual");
  const frank = await join('Frank');
  at(D7, '00:25:00');
  await start(frank.code, D7);
  const frankLate = await start(frank.code, D6);
  check(frankLate.status === 409 && /already started/.test(frankLate.error), "yesterday's battle can't start after today's");
  const gina = await join('Gina');
  at(D7, '00:31:00');
  check((await start(gina.code, D6)).status === 409, 'after 30 minutes it is too late');

  // A battle left running from yesterday is settled when today's starts.
  const dave = await join('Dave');
  at(D6, '23:59:00');
  await start(dave.code, D6);
  at(D7, '00:30:00');
  const daveToday = await start(dave.code, D7);
  const dave7 = await me(dave.code);
  check(daveToday.status === 200 && dave7.player.losses === 1 && dave7.today.status === 'running', "yesterday's unfinished battle becomes a loss when today's starts");

  // --- Reports and the admin ------------------------------------------------------
  const D8 = '2026-10-18';
  at(D8);
  const report = (code, body) => api('POST', 'reports', { code, body });
  const reportResult = (code, player, note) => report(code, { kind: 'result', player, note });
  check((await reportResult(undefined, bob.player.id)).status === 401, 'reporting a result needs a trainer');
  check((await reportResult(A, alice.player.id)).status === 400, "trainers can't report themselves");
  check((await reportResult(A, 'ZZZZZZ')).status === 404, 'reporting an unknown trainer is refused');
  check((await reportResult(A, bob.player.id, 'Three wins in a row, each in 20 seconds?')).status === 201, "Alice reports Bob's results");
  check((await reportResult(A, bob.player.id)).status === 409, 'the same trainer can only be reported once while the report is open');
  check((await reportResult(C, bob.player.id)).status === 201, 'Carol reports Bob too');
  check((await report(undefined, { kind: 'problem', note: 'x' })).status === 400, 'a problem report needs a few words');
  const problem = await report(undefined, { kind: 'problem', note: 'The game froze after RED sent Snorlax', context: { state: 'playing', rom: 'Pokémon FireRed (USA) v1.0' } });
  check(problem.status === 201, 'anyone can report a site problem, even without a trainer');
  check((await report(A, { kind: 'compliment' })).status === 400, 'unknown report kinds are refused');

  const admin = (method, path, body, token = ADMIN_TOKEN) => api(method, `admin/${path}`, { body, admin: token });
  check((await api('GET', 'admin/reports')).status === 401, 'the admin list needs the admin token');
  check((await admin('GET', 'reports', undefined, 'guess')).status === 401, 'a wrong admin token is refused');
  let open = await admin('GET', 'reports');
  const bobReports = open.reports.filter((r) => r.kind === 'result');
  check(open.status === 200 && open.reports.length === 3 && bobReports.length === 2, `the admin sees 3 open reports (${open.reports?.length})`);
  const bobTarget = bobReports[0]?.target;
  check(bobTarget?.id === bob.player.id && bobTarget.wins === 3 && bobTarget.battles.length === 3 && bobTarget.battles.every((b) => b.result === 'won' && typeof b.seconds === 'number'),
    'each result report shows the trainer with their recent battles and how long they took');
  check(bobReports.some((r) => r.note === 'Three wins in a row, each in 20 seconds?' && r.reporter?.name === 'Alice'), 'with the note and who reported it');
  const problemReport = open.reports.find((r) => r.kind === 'problem');
  check(problemReport?.context?.state === 'playing' && problemReport.reporter === null, "problem reports keep the page's context");
  check(!JSON.stringify(open).includes('client_hash') && !JSON.stringify(open).includes('token_hash'), 'the admin list leaks no hashes');

  check((await admin('POST', `players/${bob.player.id}`, { hidden: true })).status === 200, 'the admin hides Bob from the Hall of Fame');
  hof = await fame();
  check(!hof.wins.some((r) => r.id === bob.player.id), 'Bob is no longer in Most wins');
  check((await me(B)).player.hidden === true, 'Bob can see that he was hidden');
  open = await admin('GET', 'reports');
  check(open.reports.length === 1 && open.reports[0].kind === 'problem', "hiding Bob resolves the reports about him");
  check(open.hidden.some((p) => p.id === bob.player.id), 'Bob is listed as hidden');
  check((await admin('POST', `reports/${problemReport.id}`, { status: 'dismissed' })).status === 200, 'the admin dismisses the problem report');
  check((await admin('POST', `reports/${problemReport.id}`, { status: 'dismissed' })).status === 404, 'a closed report cannot be closed again');
  const closed = await admin('GET', 'reports?status=closed');
  check(closed.reports.length === 3 && closed.reports.every((r) => r.status !== 'open' && r.closedAt), 'closed reports are kept, with when they were closed');
  check((await admin('POST', `players/${bob.player.id}`, { hidden: false })).status === 200, 'the admin restores Bob');
  check((await fame()).wins.some((r) => r.id === bob.player.id), 'Bob is back in Most wins');
  check((await reportResult(A, bob.player.id)).status === 201, 'once the report was closed, Bob can be reported again');
  let limited = 0;
  for (let i = 0; i < 8; i++) limited = (await report(undefined, { kind: 'problem', note: `Problem number ${i}` })).status;
  check(limited === 429, 'at most 10 reports a day from one visitor');

  check((await api('GET', 'nothing')).status === 404, 'unknown API paths are 404');
  check((await api('POST', 'players', { body: 'x'.repeat(2000) })).status === 413, 'oversized bodies are refused');
} catch (err) {
  console.error(err);
  console.error(site.log());
  failures++;
} finally {
  site.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
