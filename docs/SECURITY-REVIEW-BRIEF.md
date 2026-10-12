# Brief for an independent security review

Scope: `server/` (a Cloudflare Worker, ~1,400 lines of plain JavaScript, no runtime dependencies)
and the interaction with the static site. Estimated effort: one working day. Two reviews were done
(2026-10-01 and 2026-10-04); findings and fixes, with a status for each, are in `ADR-001`, the last
two amendments. A further pass should concentrate on the items marked *new* below.

## What the system does
Public static site for an academic seminar; registration by magic link (no passwords); sessions;
two protected redirects (`/go/join/<slug>/`, `/go/recording/<slug>/`) that resolve to Zoom and
YouTube URLs only for a signed-in, verified account; account preferences; an admin (behind
Cloudflare Access) that stores the protected URLs and sends announcements through SMTP2GO.

## Threat model
Assets, in order: (1) the list of participants — names, affiliations, addresses; (2) the protected
session links; (3) the ability to send mail as the seminar. Adversaries: an attacker with a copy
of any database; an attacker who can run requests against the deployed Worker; a compromised mail
service; a phishing attempt against the operator. Out of scope: Cloudflare itself, the operator's
own devices, participants' mailboxes.

## What is claimed

- A **copy** of any database reveals ids, flags, timestamps, ciphertext lengths and delivery
  states — no address, name, affiliation, link or announcement text. AES-256-GCM with `DATA_KEY`
  (Worker secret), ciphertext bound to (table, id, field) via AAD and prefixed with a key
  fingerprint; address index is HMAC-SHA-256 with a separate `INDEX_KEY`. Keys cached per secret
  value; `_PREVIOUS` keys honoured during rotation (*new*: `src/crypto.js`, `src/identity/local.js`).
- The mail transport is a **trusted** part of authentication (documented, not claimed otherwise).
- Magic-link tokens: 32 random bytes, SHA-256 at rest, one conditional claim checks hash, unused
  state and expiry (*new*); the token remembers the requesting browser's nonce; the confirmation
  page names the account and refuses a token for another account while signed in (*new*).
- Sessions: 32 random bytes, SHA-256 at rest, sliding 90 days with the cookie re-issued on slide,
  absolute 365 days, identity status checked on every use, revocable (*new*); cookie
  `__Host-…; HttpOnly; Secure; SameSite=Lax` on HTTPS.
- CSRF: every POST except one-click unsubscribe requires same-origin `Origin`/`Sec-Fetch-Site`;
  GET/HEAD never change state (*new*: the announcement runner). `Referrer-Policy: same-origin`.
- Rate limits: one atomic upsert per decision (*new*: `db.js` throttle).
- Announcements: resumable initialization from a stored recipient snapshot, explicit Start,
  per-recipient claim with an attempt id required on completion, preference rechecked immediately
  before each send, bounded transport time, no automatic retry, atomic completion, idempotent job
  creation compared against the decrypted stored payload (*new*: `routes/admin.js`, `db.js` sends).
- Magic-link token removed from the URL by an immediate redirect into a signed five-minute cookie;
  the rendered confirmation form carries a keyed commitment to that token (*new*: `routes/auth.js`).
- Key-generation fence: `meta` table per database, writes conditioned on it, automatic advance along
  previous → current only (*new*: `src/fence.js`, all write paths in `db.js`/`identity/local.js`).
- Content boundary: the build accepts only regular image files inside `photos/` and regular PDF/PPT files inside `files/` (`build.mjs` safeContentFile).
- Programme editor (*new*): `/admin/talks` writes the public programme to the content repository with a
  fine-grained GitHub token (`GITHUB_CONTENT_TOKEN`, one repository, Contents read/write) and the
  protected URLs to the encrypted store; uploads checked by extension, size and magic number; sha-guarded
  updates (`routes/talks.js`, `github.js`).
- Comments form: `/api/feedback` mails a signed-in participant's plain-text message to the seminar address with their address as `Reply-To`; five an hour per account; nothing stored (*new*: `routes/auth.js` postFeedback, `mail.js` sendFeedback).
- Key migrations: fingerprint-prefixed index and ciphertexts, remaining-row counts across all
  stores, compare-and-swap writes (*new*: `crypto.js`, `identity/local.js`, `db.js`).
- Form bodies read through a counting stream reader capped at 64 KiB (*new*: `security.js` readForm).
- Admin: Access JWT verified with numeric `exp`/`nbf`, bounded JWKS refresh, fail-closed; dev bypass
  requires both Access vars empty and a loopback host (*new*).
- Headers: CSP `default-src 'none'`, HSTS, COOP/CORP, nosniff, no framing; `no-store` on the Worker.
- Logging: platform logs disabled in `wrangler.toml`; errors logged as codes only.
- Deployment: content and code in separate repositories; deploy token scoped to Workers Scripts: Edit.

## Questions we would like answered
1. Any path by which a request to the Worker returns another user's data or a protected URL
   without a valid session for a user with a profile.
2. Any way to consume or forge a magic-link or session token; any timing or race issue in the
   single-use claim.
3. Correctness of the AES-GCM use (IV per encryption, AAD binding, key handling) and of the HMAC
   index (no length-extension or misuse).
4. Injection: all SQL is parameterised; HTML escaping in `src/pages.js`; confirm no gap.
5. The Access JWT verification and the dev bypass condition.
6. The announcement job: can a chunk be replayed or a recipient list tampered with?
7. Anything in `wrangler.toml`/deployment that could expose secrets or bindings.
8. The programme editor (*new*): path traversal or name tricks in uploads, a way to write outside
   `data/talks/`, `photos/`, `files/`, or to reach any other repository; whether a crafted upload can
   break the build or the public site; the blast radius of a leaked content token.
9. The comments form: can it be used to send mail to anyone but the seminar address, to
   inject headers, or to flood the seminar's mailbox beyond the per-account limit?

## How to run it
`server/README.md` → "Local development": mock mail service, `wrangler dev`, then
`python3 test/e2e.py` (Playwright, 93 checks, exits non-zero on any failure) and
`python3 test/rotation.py --disposable 600` (key-rotation rehearsal; wipes the local data it uses).
Both derive paths from their own location. The reviewer's fixes or findings are
welcome as a written note; there is no bug-bounty budget, only the review fee.
