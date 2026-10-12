// Daily Red's API. The static site in ../web is served by Workers static
// assets; only /api/* reaches this code (see wrangler.jsonc).
//
//   POST  /api/players          {name}        -> {player, code}   new trainer + recovery code
//   GET   /api/me               (auth)        -> {player, today}  stats and today's battle
//   PATCH /api/me               (auth) {name} -> {player}
//   POST  /api/battles/start    (auth) {day, run}      -> {today}  RED's battle began
//   POST  /api/battles/result   (auth) {day, won, run} -> {player, today}
//   GET   /api/halloffame                     -> today's winners, most wins, win streaks
//   POST  /api/reports  (auth) {kind: 'result', player, note}  a trainer's results look fake
//   POST  /api/reports  (auth optional) {kind: 'problem', note, context}  the site misbehaved
//
//   Admin, with the header `X-Admin-Token: <ADMIN_TOKEN>` (a Worker secret;
//   without it these don't exist):
//   GET   /api/admin/reports?status=open|closed  -> {reports, hidden}
//   POST  /api/admin/reports/<id>   {status: 'dismissed' | 'resolved'}
//   POST  /api/admin/players/<id>   {hidden}   leave a trainer out of the Hall of Fame (or not)
//
// "auth" is the header `Authorization: Bearer <recovery code>`. `run` is a
// random ID the page picks for each battle: repeating a start with the same
// run is fine (a lost response, a retry), and only that run can send the result.
//
// The day is the UTC date, the same for everyone, and its team seed is derived
// from it here, so the browser's clock doesn't matter. Each player gets one
// battle per day: it counts from the moment RED's battle starts, and a battle
// that doesn't report a result within RESULT_WINDOW_MS is a loss. A battle can
// still start for yesterday shortly after midnight (START_GRACE_MS), for
// players who pressed Play just before it.
//
// Results are taken on trust (the battle runs in the browser): this stops
// replaying a day and keeps one result per player per day, but a determined
// player can still send a fake win.

const RESULT_WINDOW_MS = 2 * 60 * 60 * 1000;
const START_GRACE_MS = 30 * 60 * 1000;
const SETTLE_BATCH = 10; // abandoned battles settled per Hall of Fame request
const BOARD_SIZE = 20;
const TODAY_SIZE = 100;
const REPORTS_PER_DAY = 10;   // per visitor (IP), both kinds together
const ADMIN_BATTLES = 14;     // recent battles shown with a reported trainer
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

// --- Days and seeds ----------------------------------------------------------------

export const dayOf = (date) => date.toISOString().slice(0, 10);

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayOf(d);
}

// The day's team seed: FNV-1a of the date, never 0.
export function dailySeed(day) {
  let hash = 0x811c9dc5;
  for (const ch of `dailyred:${day}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

function dayInfo(now) {
  const day = dayOf(now);
  return { day, seed: dailySeed(day), now: now.toISOString(), nextDayAt: `${addDays(day, 1)}T00:00:00.000Z` };
}

// --- Players -----------------------------------------------------------------------

function randomString(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
}

// A recovery code: 25 random base32 characters (125 bits) in groups of five.
const newCode = () => randomString(25).match(/.{5}/g).join('-');

// Accepts codes typed by hand: any case, with or without dashes and spaces,
// and the usual base32 look-alikes.
export function normalizeCode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{25}$/.test(clean) ? clean : null;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 2–16 characters: letters, digits, spaces and _ - .
export function cleanName(text) {
  const name = String(text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  const length = [...name].length;
  if (length < 2 || length > 16 || !/^[\p{L}\p{N} _.\-]+$/u.test(name)) return null;
  return name;
}

function publicPlayer(row, today) {
  // Streaks only count while they're alive: played today or yesterday.
  const alive = row.last_day === today || row.last_day === addDays(today, -1);
  return {
    id: row.id,
    name: row.name,
    wins: row.wins,
    losses: row.losses,
    winStreak: alive ? row.win_streak : 0,
    dayStreak: alive ? row.day_streak : 0,
    bestWinStreak: row.best_win_streak,
    hidden: Boolean(row.hidden),
  };
}

async function authenticate(db, request) {
  const code = normalizeCode(request.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''));
  if (!code) return null;
  return db.prepare('SELECT * FROM players WHERE token_hash = ?').bind(await sha256(code)).first();
}

// --- Battles -----------------------------------------------------------------------

// Records a battle's result and updates the player's totals and streaks, in
// one transaction. With runId, only that run's battle is settled. Returns
// false if there was no such battle still running.
async function settle(db, playerId, day, won, now, runId = null) {
  const result = won ? 'won' : 'lost';
  const running = 'SELECT 1 FROM battles WHERE player_id = ?5 AND day = ?3 AND result IS NULL AND (?6 IS NULL OR run_id = ?6)';
  // SQLite evaluates every SET expression with the row's old values.
  const newWinStreak = "CASE WHEN ?1 = 1 THEN (CASE WHEN last_day = ?2 AND last_result = 'won' THEN win_streak + 1 ELSE 1 END) ELSE 0 END";
  const [, battle] = await db.batch([
    db.prepare(`UPDATE players SET
        wins = wins + ?1,
        losses = losses + 1 - ?1,
        day_streak = CASE WHEN last_day = ?2 THEN day_streak + 1 ELSE 1 END,
        win_streak = ${newWinStreak},
        best_win_streak = MAX(best_win_streak, ${newWinStreak}),
        last_day = ?3,
        last_result = ?4
      WHERE id = ?5 AND EXISTS (${running})`)
      .bind(won ? 1 : 0, addDays(day, -1), day, result, playerId, runId),
    db.prepare('UPDATE battles SET result = ?1, finished_at = ?2 WHERE player_id = ?3 AND day = ?4 AND result IS NULL AND (?5 IS NULL OR run_id = ?5)')
      .bind(result, now.toISOString(), playerId, day, runId),
  ]);
  return battle.meta.changes === 1;
}

// Battles that never reported back become losses.
async function settleAbandoned(db, now, playerId = null) {
  const cutoff = new Date(now.getTime() - RESULT_WINDOW_MS).toISOString();
  const { results } = playerId
    ? await db.prepare('SELECT player_id, day FROM battles WHERE result IS NULL AND player_id = ? AND started_at < ?').bind(playerId, cutoff).all()
    : await db.prepare(`SELECT player_id, day FROM battles WHERE result IS NULL AND started_at < ? ORDER BY started_at LIMIT ${SETTLE_BATCH}`).bind(cutoff).all();
  for (const row of results) await settle(db, row.player_id, row.day, false, now);
}

// Today's battle for a player: 'open', 'running', 'won' or 'lost'.
async function todayFor(db, playerId, now) {
  const info = dayInfo(now);
  const battle = await db.prepare('SELECT result FROM battles WHERE player_id = ? AND day = ?').bind(playerId, info.day).first();
  return { ...info, status: battle ? (battle.result ?? 'running') : 'open' };
}

// --- HTTP --------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function readBody(request, maxLength = 1000) {
  const text = await request.text();
  if (text.length > maxLength) throw new HttpError(413, 'Request too large.');
  try {
    const body = JSON.parse(text || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* fall through */ }
  throw new HttpError(400, 'Expected a JSON object.');
}

function requireRun(run) {
  if (typeof run !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(run)) throw new HttpError(400, 'Expected a run ID.');
  return run;
}

async function requirePlayer(db, request) {
  const player = await authenticate(db, request);
  if (!player) throw new HttpError(401, 'Unknown recovery code.');
  return player;
}

const reloadPlayer = (db, id) => db.prepare('SELECT * FROM players WHERE id = ?').bind(id).first();

// Admin calls need the ADMIN_TOKEN secret. Comparing digests keeps the
// comparison's timing independent of the token.
async function requireAdmin(env, request) {
  if (!env.ADMIN_TOKEN) throw new HttpError(404, 'Not found.');
  const given = request.headers.get('X-Admin-Token') ?? '';
  if ((await sha256(given)) !== (await sha256(env.ADMIN_TOKEN))) throw new HttpError(401, 'Wrong admin token.');
}

// Reports are limited per visitor and day; the IP is only kept as a hash.
async function clientHash(request, now) {
  return sha256(`${request.headers.get('CF-Connecting-IP') ?? 'local'}|${dayOf(now)}`);
}

function cleanNote(text, max) {
  return String(text ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const routes = {
  async 'POST /api/players'({ db, request, now }) {
    const name = cleanName((await readBody(request)).name);
    if (!name) throw new HttpError(400, 'Names are 2 to 16 letters, digits, spaces, dots, dashes or underscores.');
    const code = newCode();
    const tokenHash = await sha256(normalizeCode(code));
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = randomString(6);
      try {
        await db.prepare('INSERT INTO players (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
          .bind(id, name, tokenHash, now.toISOString()).run();
      } catch (err) {
        if (/UNIQUE/i.test(String(err?.message))) continue; // id already taken: draw another
        throw err;
      }
      return json({ player: publicPlayer(await reloadPlayer(db, id), dayOf(now)), code }, 201);
    }
    throw new HttpError(503, 'Try again.');
  },

  async 'GET /api/me'({ db, request, now }) {
    const player = await requirePlayer(db, request);
    await settleAbandoned(db, now, player.id);
    return json({ player: publicPlayer(await reloadPlayer(db, player.id), dayOf(now)), today: await todayFor(db, player.id, now) });
  },

  async 'PATCH /api/me'({ db, request, now }) {
    const player = await requirePlayer(db, request);
    const name = cleanName((await readBody(request)).name);
    if (!name) throw new HttpError(400, 'Names are 2 to 16 letters, digits, spaces, dots, dashes or underscores.');
    await db.prepare('UPDATE players SET name = ? WHERE id = ?').bind(name, player.id).run();
    return json({ player: publicPlayer(await reloadPlayer(db, player.id), dayOf(now)) });
  },

  async 'POST /api/battles/start'({ db, request, now }) {
    const player = await requirePlayer(db, request);
    const body = await readBody(request);
    const run = requireRun(body.run);
    const { day } = body;
    const today = dayOf(now);
    const justAfterMidnight = now.getTime() - Date.parse(`${today}T00:00:00Z`) < START_GRACE_MS;
    if (day !== today && !(day === addDays(today, -1) && justAfterMidnight)) {
      throw new HttpError(409, `That battle was for ${day}; today is ${today}.`);
    }
    if (day !== today && await db.prepare('SELECT 1 FROM battles WHERE player_id = ? AND day = ?').bind(player.id, today).first()) {
      throw new HttpError(409, "Today's battle has already started.");
    }
    // A battle from an earlier day still running here was left unfinished.
    const { results } = await db.prepare('SELECT day FROM battles WHERE player_id = ? AND result IS NULL AND day < ?').bind(player.id, day).all();
    for (const row of results) await settle(db, player.id, row.day, false, now);
    const insert = await db.prepare('INSERT OR IGNORE INTO battles (player_id, day, started_at, run_id) VALUES (?, ?, ?, ?)')
      .bind(player.id, day, now.toISOString(), run).run();
    if (insert.meta.changes !== 1) {
      // The same run asking again (its first answer got lost) is fine.
      const battle = await db.prepare('SELECT result, run_id FROM battles WHERE player_id = ? AND day = ?').bind(player.id, day).first();
      if (battle.result !== null || battle.run_id !== run) throw new HttpError(409, "You've already battled RED today.");
    }
    return json({ today: await todayFor(db, player.id, now) });
  },

  async 'POST /api/battles/result'({ db, request, now }) {
    const player = await requirePlayer(db, request);
    const { day, won, run } = await readBody(request);
    if (typeof day !== 'string' || typeof won !== 'boolean') throw new HttpError(400, 'Expected {day, won, run}.');
    requireRun(run);
    await settleAbandoned(db, now, player.id); // too late to count: it's now a loss
    if (!(await settle(db, player.id, day, won, now, run))) throw new HttpError(409, 'No battle of yours is running for that day.');
    return json({ player: publicPlayer(await reloadPlayer(db, player.id), dayOf(now)), today: await todayFor(db, player.id, now) });
  },

  async 'GET /api/halloffame'({ db, now }) {
    await settleAbandoned(db, now);
    const day = dayOf(now);
    const [today, counts, wins, streaks] = await db.batch([
      db.prepare(`SELECT p.id, p.name, b.finished_at AS at FROM battles b JOIN players p ON p.id = b.player_id
                  WHERE b.day = ? AND b.result = 'won' AND p.hidden = 0 ORDER BY b.finished_at LIMIT ${TODAY_SIZE}`).bind(day),
      db.prepare(`SELECT COUNT(*) AS played, COUNT(CASE WHEN b.result = 'won' THEN 1 END) AS won FROM battles b
                  JOIN players p ON p.id = b.player_id WHERE b.day = ? AND b.result IS NOT NULL AND p.hidden = 0`).bind(day),
      db.prepare(`SELECT id, name, wins, losses FROM players WHERE wins > 0 AND hidden = 0
                  ORDER BY wins DESC, losses ASC, created_at ASC LIMIT ${BOARD_SIZE}`),
      db.prepare(`SELECT id, name, win_streak AS streak FROM players WHERE win_streak > 0 AND last_result = 'won' AND last_day >= ? AND hidden = 0
                  ORDER BY win_streak DESC, last_day DESC, created_at ASC LIMIT ${BOARD_SIZE}`).bind(addDays(day, -1)),
    ]);
    return json({
      ...dayInfo(now),
      today: { winners: today.results, played: counts.results[0].played, won: counts.results[0].won },
      wins: wins.results,
      streaks: streaks.results,
    });
  },

  async 'POST /api/reports'({ db, request, now }) {
    const body = await readBody(request, 4000);
    const reporter = await authenticate(db, request);
    const client = await clientHash(request, now);
    const sent = await db.prepare('SELECT COUNT(*) AS n FROM reports WHERE client_hash = ?').bind(client).first();
    if (sent.n >= REPORTS_PER_DAY) throw new HttpError(429, "That's a lot of reports for one day. Try again tomorrow.");

    if (body.kind === 'result') {
      if (!reporter) throw new HttpError(401, 'Only trainers can report results.');
      const target = typeof body.player === 'string' && await reloadPlayer(db, body.player);
      if (!target) throw new HttpError(404, 'No such trainer.');
      if (target.id === reporter.id) throw new HttpError(400, "You can't report yourself.");
      const insert = await db.prepare(`INSERT OR IGNORE INTO reports (kind, reporter_id, target_id, note, client_hash, created_at)
                                       VALUES ('result', ?, ?, ?, ?, ?)`)
        .bind(reporter.id, target.id, cleanNote(body.note, 300), client, now.toISOString()).run();
      if (insert.meta.changes !== 1) throw new HttpError(409, "You've already reported this trainer.");
      return json({ ok: true }, 201);
    }

    if (body.kind === 'problem') {
      const note = cleanNote(body.note, 1000);
      if (note.length < 3) throw new HttpError(400, 'Describe the problem in a few words.');
      const context = body.context && typeof body.context === 'object' ? JSON.stringify(body.context).slice(0, 2000) : null;
      await db.prepare(`INSERT INTO reports (kind, reporter_id, note, context, client_hash, created_at)
                        VALUES ('problem', ?, ?, ?, ?, ?)`)
        .bind(reporter?.id ?? null, note, context, client, now.toISOString()).run();
      return json({ ok: true }, 201);
    }

    throw new HttpError(400, "Expected kind 'result' or 'problem'.");
  },

  async 'GET /api/admin/reports'({ db, env, request, url }) {
    await requireAdmin(env, request);
    const open = url.searchParams.get('status') !== 'closed';
    const { results: rows } = await db.prepare(`SELECT r.*, rp.name AS reporter_name FROM reports r
        LEFT JOIN players rp ON rp.id = r.reporter_id
        WHERE ${open ? "r.status = 'open'" : "r.status != 'open'"} ORDER BY r.created_at DESC LIMIT 200`).all();

    // Each reported trainer once, with their recent battles: a win reported
    // seconds after the battle started is a giveaway.
    const targets = {};
    for (const id of new Set(rows.map((r) => r.target_id).filter(Boolean))) {
      const [player, battles] = await db.batch([
        db.prepare('SELECT * FROM players WHERE id = ?').bind(id),
        db.prepare(`SELECT day, started_at, finished_at, result FROM battles WHERE player_id = ? ORDER BY day DESC LIMIT ${ADMIN_BATTLES}`).bind(id),
      ]);
      const row = player.results[0];
      targets[id] = {
        id: row.id,
        name: row.name,
        wins: row.wins,
        losses: row.losses,
        winStreak: row.win_streak,
        bestWinStreak: row.best_win_streak,
        hidden: Boolean(row.hidden),
        battles: battles.results.map((b) => ({
          day: b.day,
          result: b.result,
          seconds: b.finished_at ? Math.round((Date.parse(b.finished_at) - Date.parse(b.started_at)) / 1000) : null,
        })),
      };
    }
    const { results: hidden } = await db.prepare('SELECT id, name, wins, losses FROM players WHERE hidden = 1 ORDER BY name').all();
    return json({
      reports: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        createdAt: r.created_at,
        closedAt: r.closed_at,
        note: r.note,
        context: r.context ? parseJson(r.context) : null,
        reporter: r.reporter_id ? { id: r.reporter_id, name: r.reporter_name } : null,
        target: r.target_id ? targets[r.target_id] : null,
      })),
      hidden,
    });
  },
};

// Admin routes with an ID in the path.
const idRoutes = [
  [/^\/api\/admin\/reports\/(\d+)$/, 'POST', async ({ db, env, request, now }, id) => {
    await requireAdmin(env, request);
    const { status } = await readBody(request);
    if (status !== 'dismissed' && status !== 'resolved') throw new HttpError(400, "Expected status 'dismissed' or 'resolved'.");
    const update = await db.prepare("UPDATE reports SET status = ?, closed_at = ? WHERE id = ? AND status = 'open'")
      .bind(status, now.toISOString(), Number(id)).run();
    if (update.meta.changes !== 1) throw new HttpError(404, 'No such open report.');
    return json({ ok: true });
  }],
  [/^\/api\/admin\/players\/([0-9A-Z]{6})$/, 'POST', async ({ db, env, request, now }, id) => {
    await requireAdmin(env, request);
    const { hidden } = await readBody(request);
    if (typeof hidden !== 'boolean') throw new HttpError(400, 'Expected {hidden}.');
    const update = await db.prepare('UPDATE players SET hidden = ? WHERE id = ?').bind(hidden ? 1 : 0, id).run();
    if (update.meta.changes !== 1) throw new HttpError(404, 'No such trainer.');
    // Hiding a trainer answers the open reports about them.
    if (hidden) {
      await db.prepare("UPDATE reports SET status = 'resolved', closed_at = ? WHERE target_id = ? AND status = 'open'")
        .bind(now.toISOString(), id).run();
    }
    return json({ ok: true });
  }],
];

function findRoute(method, path) {
  const exact = routes[`${method} ${path}`];
  if (exact) return { handler: exact, args: [] };
  for (const [pattern, routeMethod, handler] of idRoutes) {
    const match = method === routeMethod && path.match(pattern);
    if (match) return { handler, args: match.slice(1) };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const verification = env.GOOGLE_SITE_VERIFICATION;
    if (verification && url.pathname === `/${verification}.html`) {
      return new Response(`google-site-verification: ${verification}.html`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const route = findRoute(request.method, url.pathname);
    if (!route) return json({ error: 'Not found.' }, 404);
    // Tests can set the server's clock (only when TEST_CLOCK=1, never in production).
    const testNow = env.TEST_CLOCK === '1' && request.headers.get('X-Test-Now');
    const now = testNow ? new Date(testNow) : new Date();
    try {
      return await route.handler({ db: env.DB, env, request, url, now }, ...route.args);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong.' }, 500);
    }
  },
};
