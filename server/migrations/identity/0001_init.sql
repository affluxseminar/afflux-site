-- Identity store: the only place that knows who an address belongs to. Separate database,
-- separate binding. Addresses are AES-GCM encrypted with DATA_KEY (a Worker secret); lookups go
-- through a keyed HMAC with INDEX_KEY so a dump of this file reveals ids, statuses, timestamps
-- and ciphertext lengths, and cannot be used to test guesses. Tokens and sessions are stored as
-- SHA-256 hashes of 256-bit random values.
CREATE TABLE identities (
  id          TEXT PRIMARY KEY,          -- opaque, immutable: "u_" + 32 hex chars
  email_key   TEXT NOT NULL UNIQUE,      -- HMAC(normalised address)
  email_enc   TEXT NOT NULL,             -- AES-GCM(address), bound to id
  status      TEXT NOT NULL,             -- pending | active
  created_at  TEXT NOT NULL,
  verified_at TEXT
);
CREATE INDEX identities_status ON identities (status, created_at);

CREATE TABLE tokens (                     -- magic links; single use
  hash        TEXT PRIMARY KEY,          -- SHA-256(token)
  identity_id TEXT NOT NULL,
  purpose     TEXT NOT NULL,             -- login | signup
  init_hash   TEXT,                      -- SHA-256 of the browser nonce that requested the link
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX tokens_identity ON tokens (identity_id);
CREATE INDEX tokens_expires ON tokens (expires_at);

CREATE TABLE sessions (
  hash        TEXT PRIMARY KEY,          -- SHA-256(session token)
  identity_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,             -- sliding
  seen_at     TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX sessions_identity ON sessions (identity_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Key generation fence. Holds the fingerprint of the DATA_KEY (and, in the identity store, the
-- INDEX_KEY) that writers must currently use. A writer whose configured key is not the active one
-- can only advance the fence if its configured previous key is the active one; otherwise every
-- encrypted write is refused. So after a rotation has been activated, a request still running on
-- the old configuration cannot commit old-key ciphertext — zero remaining rows then means zero.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
