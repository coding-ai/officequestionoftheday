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
END;

-- Cheap operational log: generation runs, fallbacks, quota errors.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
