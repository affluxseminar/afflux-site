# ADR-001 — Identity, registration, protected links and mailing

Status: **Accepted (2026-09-26), implemented in `server/`; amended 2026-09-27** — see
"Amendment" at the end: the managed identity provider was dropped in favour of an in-house
implementation on Cloudflare, and Postmark in favour of SMTP2GO. The text below records the
original reasoning; the amendment records what is built.

## Decision in one paragraph

Keep the public site static and secret-free. Add one small private server layer (Cloudflare
Worker) on the same domain, which is the only component that talks to the identity provider and
the private stores. Delegate every email-related concern — storing addresses, verifying ownership,
sending magic links, issuing and validating sessions — to **Stytch (Consumer Authentication, Email
Magic Links)** through its backend API; the browser never loads provider code. Identify users by
Stytch's opaque `user_id`. Keep Zoom and recording URLs in a separate private store that only the
Worker can read. Send announcements from a server-side job that resolves addresses from the
identity provider at send time and hands them to a transactional mail service without persisting them.

Verify two things before signing up with the provider (see "Preconditions"). Google services are
excluded by decision of the conveners: a designation of Google as an "undesirable organisation" in
Russia would expose the seminar's Russian participants, so no component may depend on Google. If
the preconditions fail for Stytch, the fallback is a self-hosted open-source identity server (Ory
Kratos) in a neutral jurisdiction — the Worker's identity adapter is the only code that changes.

## Why this provider

| Requirement | Stytch (recommended) | Self-hosted Ory Kratos (fallback) |
|---|---|---|
| Passwordless magic links, registration + sign-in | Native: `login_or_create` sends a single-use, expiring link; user stays `pending` until the link is used | Passwordless via one-time code sent by email (magic links are legacy there); registration and login flows built in |
| Sessions managed by the provider | Opaque `session_token`, 5 min – 366 days, extended on every authenticate; stored in an HttpOnly cookie set by the Worker; revocable | Kratos session cookies, configurable lifetime and extension; revocable |
| Backend-only integration (no provider JS on the site) | Yes — the site keeps `script-src 'self'` | Yes — self-service flows driven from the Worker via Kratos's API |
| Opaque user id; emails held by provider only | `user-…` id; email via server API only | Identity `id`; email in Kratos's own database, on its own host |
| Admin MFA / passkeys, access control, audit | Dashboard roles, event log in dashboard; **confirm passkey/MFA enforcement for workspace accounts** | Admin API behind SSH/VPN; audit = server logs; all operations on the team |
| Email delivery | Custom sending domain with DKIM/SPF; own templates | Any SMTP (EU service such as Mailjet or Scaleway TEM) |
| Data export / deletion | Users API (search, get, delete) | Direct database access |
| Fit with the brief | Closest: pending status, single-use links, long sliding sessions, PKCE device binding | Codes instead of links; requires someone to patch and monitor a server |

Also considered and not recommended: Google Identity Platform (excluded — see above), Auth0/Okta (heavy, and Okta restricts service in Russia),
Clerk (requires its frontend JS and cookies set from the browser), Supabase Auth (identity and
application data share one Postgres — one dump reveals both), Amazon Cognito (magic links must be
built in Lambda; passwordless there is OTP), Ory Network (passwordless is one-time code, magic
links are legacy; otherwise a good EU-hosted option), self-hosted Kratos/Keycloak (operations burden
on a volunteer team). Cloudflare Access alone caps at 50 users.

## Preconditions to verify before commitment

1. **Availability to the audience.** Since September 2024 several US providers deny service to
   users located in Russia. Before any contract: test the full flow (request link, open link,
   protected redirect) from a Russian network and obtain the provider's written policy. Same test
   for the mail service and for Cloudflare.
2. **Account holder.** The Stytch, Cloudflare and mail-service accounts, and billing, should be
   held by a person or organisation outside Russia; otherwise providers may terminate the account.
   Decide who holds them and who has admin access (two people minimum, with passkeys).

If (1) fails for Stytch, or if reliance on any US provider is judged too risky, the option is
self-hosted Ory Kratos on a server in a neutral jurisdiction (with an EU mail service), using
one-time codes instead of links. The same applies to Cloudflare: the Worker is written against web
standard APIs (`fetch`, Web Crypto) so it runs unchanged on a small Node host such as Hetzner.

**Exit readiness is the real mitigation.** Every external provider is replaceable within days:
the identity adapter is one file; user emails can be exported from the provider and re-verified by
a single sign-in on the new one; the application database and the links store contain nothing
provider-specific. A designation, a block or a policy change must not be able to strand the seminar.

## Components and boundaries

| Component | Where | Holds | Can be compromised without exposing |
|---|---|---|---|
| Public site | Cloudflare Pages (static, `dist/`) | Public programme only; no keys, no user data, no protected URLs | Everything else |
| Application server | Cloudflare Worker, routes `afflux.org/account/*`, `/go/*`, `/api/*`, `/admin/*` | Secrets in Worker Secrets: Stytch project id + secret, mail API key, HMAC key | Emails (never stored here) |
| Identity provider | Stytch project | Email addresses, verification state, magic-link tokens, sessions | Names, affiliations, preferences, links |
| Afflux user data | Cloudflare D1 database `afflux_users` | `auth_user_id`, name, affiliation, `pref_ru`, `pref_en`, `created_at`, `updated_at` | Email addresses |
| Protected links | Cloudflare D1 database `afflux_links` (separate binding) or KV | `slug → {zoom, recording}` | User data |
| Mail delivery | Postmark (or Amazon SES) | Addresses only in transit per send; delivery logs with retention set to the minimum | The user table |
| Admin | Worker routes behind Cloudflare Access | — | — |

Each store has its own binding and credentials. The Worker is the only principal with access to
more than one of them, and it holds no email address at rest.

## Data model

```sql
users (
  auth_user_id TEXT PRIMARY KEY,        -- Stytch user_id, opaque and immutable
  name         TEXT NOT NULL,
  affiliation  TEXT,
  pref_ru      INTEGER NOT NULL DEFAULT 0,
  pref_en      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
pending_profiles (                       -- held only until the registration link is used
  auth_user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL, affiliation TEXT, pref_ru INTEGER, pref_en INTEGER,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
-- separate database:
links (slug TEXT PRIMARY KEY, zoom TEXT, recording TEXT, updated_at TEXT);
```

No email, no password, no hash of an email, no IP addresses, no analytics.

## Flows

**Registration** (from a talk page after pressing Join or Watch recording, or from /register/)

Registration is an account on the site, not a mailing-list signup: its purpose is access to the
protected links. The mailing checkboxes are optional extras on the same form.

1. Form: email (required), name (required), affiliation (optional), two optional checkboxes:
   announcements of English-language sessions, announcements of Russian-language sessions. A
   visitor may tick both, either, or neither. POST to the Worker.
2. Worker: rate-limit check; calls Stytch `magic_links.email.login_or_create` with the site's
   callback URL, `signup_expiration_minutes` = 1440, PKCE code challenge. Stytch creates the user
   with status `pending` and sends the link. Worker stores `{auth_user_id, name, affiliation,
   prefs, expires_at}` in `pending_profiles` and the requested return path in a short-lived signed
   cookie. Nothing else is granted.
3. Visitor opens the link → Worker callback `/account/verify?token=…` → Stytch
   `magic_links.authenticate(token, session_duration_minutes=43200)` verifies single use and expiry
   and returns `user_id`, `session_token`, and the user's status (`active` from now on).
4. Worker moves the pending profile to `users` (preferences become active only now), sets the
   session cookie, redirects to the return path if it is on the allow-list, else to /account/.
5. Cron (daily): delete `pending_profiles` past `expires_at` and delete the corresponding still-
   `pending` Stytch users, so an unverified registration leaves nothing behind.

An unverified registration grants nothing: no session, no access to `/go/*`, no mailing. If the
link is never opened, the pending profile and the pending provider user are deleted after 24 hours
and the address can register again from scratch.

**Sign-in.** Email → Worker calls `login_or_create` (existing users get a login link, 60 min) →
link → callback → session cookie → return path. Sessions last 90 days and are extended on each visit; a visitor who comes at least once a
quarter never sees the form again. Sign out revokes the
Stytch session and clears the cookie; "sign out everywhere" revokes all sessions of the user.

**Protected resource.** Public pages link to `/go/join/<slug>` and `/go/recording/<slug>` (the
build emits these links from boolean flags; the real URLs never enter the repository or the build).
The Worker: reads the cookie → Stytch `sessions.authenticate` (server-side, every time) → confirms
the user exists in `users` → reads the URL from the links store → 302 to it. No session: renders the
sign-in/register page with the return path remembered, without revealing the destination. Session
but no user row (deleted account): sign-in page.

**Mailing preferences.** `/account/` shows name, affiliation, the two toggles, sign out. Changes
POST to the Worker; no email confirmation. Every announcement carries `List-Unsubscribe` and a
one-click endpoint carrying an HMAC-signed `{auth_user_id, list, expiry}` token, so unsubscribing
from the mail client needs no sign-in.

**Announcement send** (admin, behind Cloudflare Access). Pick the talk and the list. The Worker
selects `auth_user_id` where the preference is on, resolves addresses through Stytch's users API in
batches, submits one batch to the mail service with individual recipients and headers, and keeps
only counts and the send timestamp. Addresses are not written anywhere. The RU and EN lists are
independent sends with their own templates.

**Secretary's weekly task.** Unchanged for public content (`talks.json` via the CMS or the GitHub
editor). Zoom and recording URLs are entered in the admin page of the Worker, keyed by the talk's
slug, instead of `talks.json`. The talk entry keeps two booleans, `join` and `recording`, which
control whether the buttons appear.

## Security controls

- Server-side authorization on every `/go/*` and `/api/*` request; the UI never decides.
- Session cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`, sliding, revocable; PKCE binds magic
  links to the device that requested them where possible (cross-device opens fall back to a
  confirm-email step).
- CSRF: `SameSite=Lax` plus `Origin`/`Sec-Fetch-Site` checks on every POST; magic-link callbacks
  are single-use tokens validated by the provider.
- Return-path allow-list (`/go/…`, `/account/…` only) to prevent open redirects.
- Rate limiting: Cloudflare rules on `/api/auth/*` (per IP and per email hash in memory only),
  provider-side throttling; Turnstile can be added without touching the static site if abuse appears.
- Headers: the existing CSP tightens (`form-action 'self'`), HSTS, COOP/CORP, no framing.
- Secrets only in Worker Secrets; least-privilege API keys; rotation procedure documented.
- Admin: Cloudflare Access with an identity provider that enforces passkeys/MFA, at least two admins,
  Access audit logs; admin routes are not reachable without an Access token.
- Logging: no email addresses in Worker logs; provider event logs for authentication.
- Retention: pending profiles 24 h; provider sessions 90 days, sliding; mail-service activity retention at
  the minimum offered; account deletion = delete Stytch user + `users` row, documented in /account/.
- Backups: D1 exports contain no emails; provider export is available for migration.

## Implementation notes (as built)

- Deployment: one Worker with static assets (`server/wrangler.toml`, `[assets]`), routes for the
  dynamic paths in `run_worker_first`; the rest is served as files with no bindings.
- The magic-link landing page requires a button press before the token is exchanged, so link
  prefetching by mail scanners cannot consume a single-use token or sign in on the scanner's behalf.
- Sign-in with an unknown address issues a registration link; after verification the visitor
  completes name/affiliation/preferences. The "check your email" page is identical in both cases.
- Return path after sign-in: an allow-listed site path in a signed, one-hour cookie — never a
  parameter in the emailed link.
- Rate limits: per client and per address, short windows, keyed hashes only, purged daily;
  Cloudflare rate-limiting rules on `/api/*` are configured at the edge in addition.
- Tested end to end against local stand-ins for the provider and the mail service
  (`server/test/mock-services.mjs`): 35 checks covering gating, registration, verification,
  return to the resource, sign-in, profile completion, preferences, announcements, one-click
  unsubscribe, deletion, CSRF rejection, throttling and the nightly clean-up.

## Decisions added on 2026-09-26

- Recordings: Zoom live-streamed to YouTube (unlisted); the pre-scheduled stream URL is entered
  as the recording link before the session. Cloudflare Stream was offered and declined.
  Known consequences accepted by the conveners: YouTube is a Google service and is throttled in
  Russia; an unlisted link can be forwarded.
- Mail: a single sender address for sign-in links, announcements and replies (`MAIL_FROM`),
  authenticated with SPF, DKIM (one selector per service) and DMARC.

## What changes in the repository

- `talks.json`: `zoom`/`recording` URL fields are replaced by booleans `join`/`recording`; the build
  refuses any `https://zoom.` value in the public data.
- The public Subscribe page is removed. Nav item becomes "Register" (signed-out) / "Account"
  (signed-in); the Worker renders /register/, /signin/ and /account/ with the site's own templates.
- The two lists are keyed by session language and written in that language, with no bilingual
  duplication: an English-language session is announced in English to the EN list, a Russian-language
  session in Russian to the RU list; a reader who follows both ticks both. Both toggles can be
  switched on or off at any time on /account/ without a new confirmation email. The registration
  form lists the option matching the interface language first; neither box is pre-ticked.
- New folder `server/` with the Worker (no framework, no dependencies beyond the Stytch and mail
  HTTP APIs called with `fetch`), `wrangler.toml` bindings, D1 migrations, and an identity adapter
  interface with two implementations planned (Stytch first).
- CMS config: the Zoom/recording fields are removed from the public editor.

## Cost and effort

Cloudflare Pages + Workers + D1: free tier suffices; Stytch: free tier at this scale; mail service:
roughly USD 15/month. Implementation: about a week of work, half of which is the admin and mailing
part. No change to the public design.

## Amendment (2026-09-27): no identity provider, SMTP2GO for mail

Context. The seminar is run by one person in Moscow with no co-holder abroad. US identity and
mail providers may refuse Russia-based customers; an account obtained by misrepresenting location
would be a liability. The original brief preferred a managed provider *if one can handle it*; for
this operator none reliably can.

Decision.
- Identities, magic links and sessions are implemented in the Worker (`src/identity/local.js`):
  256-bit random tokens stored as SHA-256 hashes, single use, expiring; sessions sliding and
  revocable; a button between the emailed link and the token exchange.
- Addresses live in a third, separate database, encrypted (AES-256-GCM, key in Worker secrets)
  and indexed by a keyed HMAC — not a plain hash, so a dump cannot be reversed or used to test
  guesses. Names, affiliations and the protected Zoom/recording URLs are encrypted the same way,
  each ciphertext bound to its row. A dump of any database reveals ids, flags and timestamps.
- Mail delivery: SMTP2GO (New Zealand), one message per API call; announcements run as chunked
  jobs that keep recipient ids and counts, never addresses. Only two external services remain:
  Cloudflare and SMTP2GO.
- The digest list is not built; the two announcement lists stay.

Consequences. The seminar, not a SOC 2 provider, is responsible for the identity store; the
compensating controls are encryption at rest, separate databases and bindings, secrets outside
the databases, passkeys on the Cloudflare account, and an offline copy of `DATA_KEY`. Exposure at
the mail service is bounded to its delivery log (recipients and subjects, 30 days). The interface
of the identity module is unchanged, so a managed provider can be reinstated by replacing one file.

## Amendment (2026-10-01): response to the independent review

An independent source review (42 local checks, 13 defect reproductions) confirmed the encryption,
the keyed index, token single-use and the access gates, and found the following, now fixed and
covered by the end-to-end suite (52 checks, exits non-zero on failure):

| Finding | Fix |
|---|---|
| S02 announcement chunks could overlap or be re-sent | per-recipient delivery rows; atomic claim per recipient; `sent / failed / unknown / skipped` states; no automatic retry; explicit retry actions; idempotency key on the confirmation |
| S03 GET/HEAD triggered delivery | processing only on POST (same-origin, Access); GET/HEAD show progress |
| S04 rate limit not atomic | single conditional upsert with RETURNING decides admission |
| S05 key rotation unsafe | keys cached per secret value; address index on its own `INDEX_KEY`; `_PREVIOUS` keys honoured; ciphertexts carry a key fingerprint; Reindex / Re-encrypt admin actions; "sign everyone out"; corrected README |
| S06 forwarded link switched a signed-in browser | confirmation page names the account (masked), says whether this browser requested the link, and refuses a token for a different account while signed in |
| S07 unsubscribe ignored by queued job | preference rechecked immediately before each send |
| S08 permissive JWT claims; bypass condition | numeric `exp`/`nbf` required, bounded JWKS refresh on key miss, fail-closed parsing; bypass needs both Access vars empty and a loopback host |
| S09 cookie did not slide | cookie re-issued whenever the session slides; absolute lifetime 365 days; `__Host-` prefix on HTTPS |
| S10 admin overview crashed after a send | fixed field, covered by a test |
| S11 expiry checked before the claim | one conditional UPDATE checks hash, unused and expiry |
| D01 announcement text in clear | subject and body encrypted; guarantee reworded to the exact field-level statement |
| D02 CMS and deployment shared one authority | two repositories: content (secretary, CMS) and code (owner); deploy token scoped to Workers Scripts: Edit |
| D03 tokens could reach request logs | `[observability] enabled = false`; `Referrer-Policy: same-origin` on the Worker; error logging by code only; canary check in the staging checklist |
| D04 hosts of protected links unrestricted | allow-list (zoom.us, youtube.com, youtu.be) |
| D05 test suite did not fail the build; body size unbounded | exit code; `Content-Length` bound before parsing |

S01 — the mail transport as part of the authentication trust base — is accepted as inherent to
email-link sign-in and documented as such (server/README.md, "Who is trusted"), with the
mitigations listed there. The claim "a hardware key on the operator's account protects
participants from this" is withdrawn. A participant-side second factor (passkeys) would remove
the dependence and is noted as future work.

## Amendment (2026-10-04): response to the follow-up review

Status vocabulary used from here on: **implemented** (in the code), **locally tested** (covered by
`server/test/e2e.py` or `test/rotation.py` against the local Worker, real Web Crypto and SQLite),
**staging-verified** (exercised on `test.affluxseminar.org` with real D1, Access and mail — none yet).

| Finding | Fix | Status |
|---|---|---|
| R2-12 production routes swallowed by `[observability]` | table moved below all top-level keys; checked with a TOML parser and `wrangler deploy --dry-run` for both environments | implemented, locally tested |
| R2-13 content repository held a code credential | no workflow and no secret in the content repository; the code repository polls it every 15 minutes (`git ls-remote`, public) and deploys on change; `environment: production`; token scoped to Workers Scripts: Edit | implemented |
| R2-01 announcement text left out of DATA_KEY migration | re-encryption covers identities, profiles, pending profiles, announcements, links; maintenance page counts remaining rows across all stores and only then says the previous key may be removed from configuration | implemented, locally tested (600 identities) |
| R2-02 reindex stopped at 500 rows | index entries carry the key fingerprint; passes select rows still on another key; completion is a count | implemented, locally tested (600 identities, 7 passes) |
| R2-10 migration overwrote a concurrent edit | every migration write is compare-and-swap against the value read | implemented |
| R2-08/09 no v1 → v2 path | documented: schema 2 is for a fresh install; legacy index format recognised via `INDEX_KEY_PREVIOUS`; table migrations for a populated v1 not provided | documented |
| R2-03 interrupted initialization hid recipients | `initializing` state, stored recipient snapshot, resumable creation, runnable only when complete | implemented, locally tested |
| R2-04 concurrent identical confirmations errored | `INSERT OR IGNORE` then read back the winner; key bound to a payload hash | implemented, locally tested |
| R2-05 stale attempt completed a newer attempt's row | attempt id on claim, required on completion; sweep clears ownership; outbound send bounded to 20 s | implemented, locally tested |
| R2-06 body bound only by Content-Length | streaming reader counts bytes and stops at 64 KiB for every form parser incl. unsubscribe | implemented, locally tested (140 kB chunked → 413) |
| R2-07 query budget | chunk now ~6 database calls; to be measured on the real plan | implemented; staging pending |
| R2-11 JWKS refresh per request | single-flight fetch, 60 s refresh cooldown, negative cache per key id, issuer/audience pre-checks | implemented |
| S03 qualification (auto-submit) | nothing is sent until the operator presses Start; auto-continue only afterwards | implemented, locally tested |
| S06 qualification (cross-device) | `LINK_BINDING = "strict"` option refuses links in other browsers; default warns | implemented |
| D03 token in Referer / logs | token moved out of the URL into a signed cookie by an immediate redirect; `Referrer-Policy: same-origin`; logging statement corrected | implemented, locally tested |
| R2-14 test suite | portable paths, strict subprocess errors, 63 checks, CI gate before deploy; `test/rotation.py` for rotation | implemented |
| R2-15 CMS photos path | `--content` is the repository root (`data/talks.json`, `photos/`) | implemented, locally tested |

Not changed, by decision: the mail transport remains part of the authentication trust base (S01);
a verified participant can forward an external destination (D04).

## Amendment (2026-10-04, later): response to the third review

| Finding | Fix | Status |
|---|---|---|
| R3-01 confirmation page could confirm a newer token | the rendered form carries a keyed commitment to its token; a mismatch is answered with the current account's page and consumes nothing | implemented, locally tested |
| R3-06 content symlink crossed into the build | build refuses symbolic links, non-regular and unexpected files, out-of-directory resolutions, oversized files, symlinked `talks.json`/`photos`; checkouts with `persist-credentials: false`; permissions `contents: read` only | implemented, locally tested |
| R3-07 cache used as deployment record | the live site serves `content-version.txt`; the workflow deploys when it differs from the repository's HEAD; malformed `ls-remote` fails the job | implemented |
| R3-05 zero counters not a write barrier | key-generation fence in every database: encrypted writes conditioned on the fence; automatic advance along previous → current; old-generation writers and rollbacks refused (503) | implemented, locally tested (rehearsal with a held old-generation writer) |
| R3-02 preference stale within a chunk | per-recipient recheck immediately before each send | implemented, locally tested |
| R3-09 completion raced retry | completion is one conditional statement; retry resets targets first, then the job | implemented, locally tested |
| R3-03 unkeyed payload hash | removed; a reused key is compared against the decrypted stored announcement | implemented, locally tested |
| R3-08 JWKS failure backoff, issuer scoping | 30 s backoff after a failed fetch; cache keyed by team domain | implemented |
| R3-04 expiry compared with a prepared timestamp | compared with the database clock at claim execution | implemented, locally tested |
| test coverage | 69 end-to-end checks; rotation rehearsal requires `--disposable` and wipes the local data it used; CI builds from the selected content and runs both suites before deploy | implemented |

Unchanged by decision: S01, D04. Nothing is staging-verified yet.

## Amendment (2026-10-12): content corrections, documents, comments form, phone layout

| Change | Detail | Status |
|---|---|---|
| Comments and suggestions | `/account/feedback` (GET) and `/api/feedback` (POST), signed-in accounts with a profile only; same-origin and generic throttle as every POST, plus five messages an hour per account (keyed-hash throttle `fb:<id>`); plain text with control characters removed, 6 000 characters; mailed through the existing transport to `FEEDBACK_TO` or the `MAIL_FROM` address with `Reply-To` set to the participant's address; nothing stored. The address is read from the identity store for this one message, as it is for sign-in links. | implemented, locally tested (9 checks) |
| Documents in the content repository | `files/` next to `photos/`: slides and minutes as PDF/PPT/PPTX, same boundary rules as photos (regular files only, name pattern, 40 MB, no symlinks, no unexpected files); `talks.json` gains `minutes`; both `slides` and `minutes` accept an `https://` address or a file name; the build verifies that referenced files exist | implemented, locally tested |
| `safeNext` | `/account/feedback` added to the allow-list of return paths (sign-in page now also honours `?next=`) | implemented |
| Privacy note | wording corrected: the address is stored encrypted, separately from the profile (it no longer says "held by the sign-in service") | implemented |
| Phone layout | header static on phones, 32 px theme targets, full-width primary buttons, tap-sized links in ledgers, figure shown below forms instead of hidden, `figure.field` scoped so form fields no longer inherit the figure's colour and sizes | implemented, screenshots at 360/390 |
| Test helper | `d1()` tolerates a notice printed by wrangler before its JSON (proxy environments) | implemented |
| test coverage | 78 end-to-end checks | implemented |

Unchanged by decision: S01, D04. Nothing is staging-verified yet.

## Amendment (2026-10-12, later): programme editor in the admin

| Change | Detail | Status |
|---|---|---|
| Programme editor | `/admin/talks` behind Access: one form writes the public fields to the content repository (`data/talks/<slug>.json`, `photos/`, `files/`) through the GitHub Contents API and the Zoom/recording URLs to the encrypted links store; flags `join`/`recording` derived from what is stored; uploads validated by name, size and magic number; optimistic concurrency on the file sha; body cap 24 MB on this route only (`routes/talks.js`, `github.js`) | implemented, locally tested (15 checks against a GitHub stand-in) |
| New secret | `GITHUB_CONTENT_TOKEN`: fine-grained, one repository, Contents read/write. Trust boundary: its holder can change programme text and files, not code, keys or the databases; the build still treats the repository as untrusted input | implemented, documented |
| Content layout | one file per seminar in `data/talks/`; `data/talks.json` still read if present; the Decap CMS template and the offline form removed (superseded) | implemented |
| Rebuild cadence | content polled every 10 minutes | implemented |
| test coverage | 93 end-to-end checks; results are printed even when a run aborts | implemented |
| Russian typesetting | non-breaking spaces after prepositions and conjunctions, before dashes, inside initials and before units, applied at render time to every Russian string, field and paragraph (`render.js` typo/typoSite; the server's pages use the same); phones in Russian get a two-column menu; the masthead line is a three-place grid; Russian running text hyphenated by the browser | implemented |
| Figure caption | plain words, no formula: a uniform stream superimposed with a point sink and a vortex; the Greek/maths font supplement removed | implemented |
| Second domain | affluxseminar.com: redirect-only zone, SPF `-all`, DMARC reject, no MX (`docs/DNS.md`) | documented |

Unchanged by decision: S01, D04. Nothing is staging-verified yet.
