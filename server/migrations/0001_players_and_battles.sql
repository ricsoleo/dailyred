-- Players and their daily battles with RED.

CREATE TABLE players (
  id TEXT PRIMARY KEY,               -- public, shown next to the name, e.g. K7Q2MX
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the secret token (the recovery code)
  created_at TEXT NOT NULL,
  -- Running totals, updated when a battle is settled (see settle() in src/index.js).
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  win_streak INTEGER NOT NULL DEFAULT 0,       -- daily wins in a row, as of last_day
  best_win_streak INTEGER NOT NULL DEFAULT 0,
  day_streak INTEGER NOT NULL DEFAULT 0,       -- days played in a row, as of last_day
  last_day TEXT,                               -- day of the latest settled battle
  last_result TEXT                             -- 'won' or 'lost'
);

-- One battle per player per day. result is NULL while the battle is running;
-- a battle that never reports back is settled as a loss. Only the page that
-- started it (run_id) can report its result.
CREATE TABLE battles (
  player_id TEXT NOT NULL REFERENCES players(id),
  day TEXT NOT NULL,                 -- UTC date, e.g. 2026-10-12
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  run_id TEXT NOT NULL,              -- random ID from the page playing it (repeat starts, results)
  PRIMARY KEY (player_id, day)
);

CREATE INDEX battles_by_day ON battles(day, result, finished_at);
CREATE INDEX battles_running ON battles(started_at) WHERE result IS NULL;
CREATE INDEX players_by_wins ON players(wins DESC);
