-- Reports from players (suspicious results, site problems), and hiding a
-- trainer from the Hall of Fame once the admin has looked at the reports.

ALTER TABLE players ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0; -- 1: left out of the Hall of Fame

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                       -- 'result': a trainer's results look fake; 'problem': the site misbehaved
  reporter_id TEXT REFERENCES players(id),  -- NULL for a problem reported by a visitor without a trainer
  target_id TEXT REFERENCES players(id),    -- the reported trainer ('result' only)
  note TEXT NOT NULL DEFAULT '',
  context TEXT,                             -- 'problem': JSON describing the page (state, error, browser)
  client_hash TEXT NOT NULL,                -- SHA-256 of the visitor's IP and the day, for the daily limit
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- 'open', 'dismissed' or 'resolved'
  closed_at TEXT
);

-- One open report per reporter and trainer.
CREATE UNIQUE INDEX reports_open_once ON reports(reporter_id, target_id) WHERE kind = 'result' AND status = 'open';
CREATE INDEX reports_by_status ON reports(status, created_at);
CREATE INDEX reports_by_client ON reports(client_hash);
