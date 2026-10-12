-- Afflux application data, keyed by the identity store's opaque id. Name and affiliation are
-- AES-GCM encrypted with DATA_KEY (a Worker secret) and bound to the row; a dump of this file
-- shows ids, two preference flags, timestamps, counters and ciphertext lengths.
CREATE TABLE users (
  auth_user_id    TEXT PRIMARY KEY,
  name_enc        TEXT NOT NULL,
  affiliation_enc TEXT,
  pref_ru         INTEGER NOT NULL DEFAULT 0,
  pref_en         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX users_pref_ru ON users (pref_ru);
CREATE INDEX users_pref_en ON users (pref_en);

CREATE TABLE pending_profiles (
  auth_user_id    TEXT PRIMARY KEY,
  name_enc        TEXT NOT NULL,
  affiliation_enc TEXT,
  pref_ru         INTEGER NOT NULL DEFAULT 0,
  pref_en         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX pending_expires ON pending_profiles (expires_at);

-- Request counters keyed by a keyed hash; one atomic upsert per decision; purged hourly.
CREATE TABLE throttle (
  key          TEXT PRIMARY KEY,
  hits         INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Announcement jobs. Subject and body are encrypted (an operator may paste a protected link);
-- the job never holds an address. One row per recipient records what happened to that delivery.
CREATE TABLE sends (
  id           TEXT PRIMARY KEY,         -- "s_" + 32 hex
  idem_key     TEXT NOT NULL UNIQUE,     -- from the confirmation form: a double submit creates no second job
  list         TEXT NOT NULL,
  subject_enc  TEXT NOT NULL,
  body_enc     TEXT NOT NULL,
  status       TEXT NOT NULL,            -- initializing | running | done
  intended     INTEGER NOT NULL,         -- number of recipients the job was created for
  targets      TEXT NOT NULL,            -- JSON array of their ids (the durable snapshot a resumed initialization completes from)
  created_at   TEXT NOT NULL,
  started_at   TEXT,                     -- set by the operator's explicit "Start" (nothing is sent before)
  finished_at  TEXT
);
CREATE TABLE send_targets (
  send_id      TEXT NOT NULL,
  auth_user_id TEXT NOT NULL,
  state        TEXT NOT NULL,            -- pending | sending | sent | failed | unknown | skipped
  attempt_id   TEXT,                     -- the claim that currently owns the row; completion must match it
  attempts     INTEGER NOT NULL DEFAULT 0,
  claimed_at   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (send_id, auth_user_id)
);
CREATE INDEX send_targets_state ON send_targets (send_id, state);

-- Key generation fence. Holds the fingerprint of the DATA_KEY (and, in the identity store, the
-- INDEX_KEY) that writers must currently use. A writer whose configured key is not the active one
-- can only advance the fence if its configured previous key is the active one; otherwise every
-- encrypted write is refused. So after a rotation has been activated, a request still running on
-- the old configuration cannot commit old-key ciphertext — zero remaining rows then means zero.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
