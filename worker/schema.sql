-- ============================================================
-- Office Question of the Day — D1 schema
-- Apply with:  wrangler d1 execute oqotd --remote --file=./schema.sql
-- ============================================================

DROP TRIGGER IF EXISTS vote_counters;

CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  text          TEXT    NOT NULL UNIQUE,
  option_a      TEXT    NOT NULL,
  option_b      TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT 'general',
  -- universal: harmless private habits (the distribution engine)
  -- workplace: opinions about working life (the dataset)
  genre         TEXT    NOT NULL DEFAULT 'universal',
  -- draft: awaiting your review | approved: eligible to publish
  -- retired: never publish | rejected: failed review
  status        TEXT    NOT NULL DEFAULT 'draft',
  source        TEXT    NOT NULL DEFAULT 'curated',   -- curated | generated
  predicted_a   INTEGER,                              -- model's guess at % choosing A
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Which question runs on which UTC date. Immutable once written:
-- everyone in the world sees the same question on the same date.
CREATE TABLE IF NOT EXISTS schedule (
  publish_date  TEXT    PRIMARY KEY,                  -- 'YYYY-MM-DD' (UTC)
  question_id   INTEGER NOT NULL REFERENCES questions(id),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_question ON schedule(question_id);
CREATE INDEX IF NOT EXISTS idx_questions_pick ON questions(status, genre, created_at);

-- One row per vote. This is the analytics asset — keep it forever.
-- No IP address, no user agent string, no identifier that maps to a person.
CREATE TABLE IF NOT EXISTS votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id   INTEGER NOT NULL REFERENCES questions(id),
  publish_date  TEXT    NOT NULL,
  choice        INTEGER NOT NULL CHECK (choice IN (0, 1)),
  country       TEXT,                                 -- ISO-2, from Cloudflare edge
  continent     TEXT,
  is_mobile     INTEGER NOT NULL DEFAULT 0,
  weekday       INTEGER,                              -- 0=Sun .. 6=Sat, UTC
  hour_utc      INTEGER,
  room_code     TEXT,                                 -- optional office room
  client_id     TEXT    NOT NULL,                     -- random UUID from the browser
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (question_id, client_id)                     -- one vote per browser per question
);
CREATE INDEX IF NOT EXISTS idx_votes_date    ON votes(publish_date);
CREATE INDEX IF NOT EXISTS idx_votes_country ON votes(question_id, country);

-- Denormalised counters. Never COUNT(*) the votes table on a page load:
-- a viral question would burn your entire daily read quota in minutes.
CREATE TABLE IF NOT EXISTS tallies (
  question_id   INTEGER PRIMARY KEY REFERENCES questions(id),
  count_a       INTEGER NOT NULL DEFAULT 0,
  count_b       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS country_tallies (
  question_id   INTEGER NOT NULL REFERENCES questions(id),
  country       TEXT    NOT NULL,
  count_a       INTEGER NOT NULL DEFAULT 0,
  count_b       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (question_id, country)
);

-- Counters are maintained by the database, not the application, so they
-- can never drift out of sync with the vote rows.
CREATE TRIGGER vote_counters AFTER INSERT ON votes
BEGIN
  INSERT INTO tallies (question_id, count_a, count_b)
  VALUES (NEW.question_id, NEW.choice = 0, NEW.choice = 1)
  ON CONFLICT (question_id) DO UPDATE SET
    count_a = count_a + (NEW.choice = 0),
    count_b = count_b + (NEW.choice = 1);

  INSERT INTO country_tallies (question_id, country, count_a, count_b)
  VALUES (NEW.question_id, COALESCE(NEW.country, 'ZZ'), NEW.choice = 0, NEW.choice = 1)
  ON CONFLICT (question_id, country) DO UPDATE SET
    count_a = count_a + (NEW.choice = 0),
    count_b = count_b + (NEW.choice = 1);

  INSERT INTO room_tallies (room_code, question_id, count_a, count_b)
  SELECT NEW.room_code, NEW.question_id, NEW.choice = 0, NEW.choice = 1
   WHERE NEW.room_code IS NOT NULL
  ON CONFLICT (room_code, question_id) DO UPDATE SET
    count_a = count_a + (NEW.choice = 0),
    count_b = count_b + (NEW.choice = 1);
END;

-- ── Office rooms ────────────────────────────────────────────────
-- A four-character code someone shares with their team. Turns the unit of
-- adoption from one person into one office, and gives everyone in it a
-- running scoreboard worth coming back to.
CREATE TABLE IF NOT EXISTS rooms (
  code        TEXT PRIMARY KEY,                       -- 4 chars, unambiguous alphabet
  name        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_vote   TEXT
);

CREATE TABLE IF NOT EXISTS room_tallies (
  room_code   TEXT    NOT NULL,
  question_id INTEGER NOT NULL,
  count_a     INTEGER NOT NULL DEFAULT 0,
  count_b     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_code, question_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_room ON votes(room_code, question_id);

-- ── Push subscriptions ──────────────────────────────────────────
-- Payload-less web push: we store no message content and send none. The
-- service worker fetches the current question when it wakes, so a delayed
-- notification still shows today's question rather than yesterday's.
--
-- The endpoint URL is a per-device identifier, so this is the one table
-- holding anything personal. Rows are deleted the moment a push service
-- reports the subscription is gone (404/410), and the browser's own
-- notification settings are the user's off switch.
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint      TEXT PRIMARY KEY,
  -- Precomputed at subscribe time: the UTC hour at which it is ~9am for
  -- this person. Lets the hourly cron select by index instead of scanning.
  send_hour_utc INTEGER NOT NULL,
  fails         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_sent     TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_hour ON push_subs(send_hour_utc);

-- Cheap operational log: generation runs, fallbacks, quota errors.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
