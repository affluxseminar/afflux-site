-- Protected seminar resources, keyed by the public talk slug. Read only by the /go/ resolver;
-- values are AES-GCM encrypted with DATA_KEY and bound to the slug.
CREATE TABLE links (
  slug       TEXT PRIMARY KEY,
  zoom       TEXT,
  recording  TEXT,
  updated_at TEXT NOT NULL
);

-- Key generation fence. Holds the fingerprint of the DATA_KEY (and, in the identity store, the
-- INDEX_KEY) that writers must currently use. A writer whose configured key is not the active one
-- can only advance the fence if its configured previous key is the active one; otherwise every
-- encrypted write is refused. So after a rotation has been activated, a request still running on
-- the old configuration cannot commit old-key ciphertext — zero remaining rows then means zero.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
