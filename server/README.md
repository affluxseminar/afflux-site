# AFFLUX application server

The private layer of the site: registration and sign-in by magic link, sessions, the protected
`/go/` links, account preferences, the announcement mailing and its admin. A single Cloudflare
Worker with no runtime dependencies and no identity provider: links, sessions and identities are
ours, on Cloudflare, with addresses, names, affiliations and protected URLs encrypted at rest.
The static site (`../dist`) is served by the same deployment as plain files.

```
src/index.js            router and the daily job
src/identity/local.js   identities, magic-link tokens and sessions (the only file that touches IDENTITY_DB)
src/crypto.js           HMAC (cookies, address index, throttle keys) and AES-GCM (fields at rest)
src/routes/auth.js      register, sign-in, verify, account, sign-out, delete
src/routes/go.js        /go/join/<slug>/ and /go/recording/<slug>/ — session, account, then redirect
src/routes/unsubscribe.js  one-click unsubscribe with a signed, expiring token
src/routes/admin.js     protected links and announcements, behind Cloudflare Access
src/pages.js            pages rendered with the site's own templates and strings
src/db.js               users (application data) and links (protected URLs), encryption hidden inside
src/security.js         headers, same-origin check for POST, rate limits, return-path allow-list
src/access.js           verification of the Cloudflare Access JWT on /admin
src/mail.js             SMTP2GO: sign-in link messages and announcements, one message per request
migrations/             schema for the three databases
test/mock-services.mjs  local stand-in for SMTP2GO
```

## What is stored where, and what a copy of it reveals

| Store | Encrypted (AES-256-GCM, `DATA_KEY`) | In clear |
|---|---|---|
| D1 `afflux_identity` | address | opaque id; keyed address index (HMAC, `INDEX_KEY`); status; timestamps; token and session hashes |
| D1 `afflux_users` | name, affiliation, announcement subject and body | opaque id; two list flags; timestamps; throttle counters (keyed hashes); per-recipient delivery states |
| D1 `afflux_links` | Zoom and recording URLs | public talk slug; timestamps |
| Worker secrets | — | `SIGNING_KEY`, `INDEX_KEY`, `DATA_KEY`, `SMTP2GO_API_KEY` (+ `_AUTH`) |
| SMTP2GO | — | its delivery log: recipients and subjects of sends (30 days); no message content |

Exactly what a copy of a database gives an attacker: ids, flags, timestamps, ciphertext lengths,
and which ids received which announcement. Not a name, not an address, not a link. Every
ciphertext is bound to its row (table, id, field): a value cannot be copied into another record.
The address index is a keyed hash: without `INDEX_KEY` it cannot be reversed or used to test a
guessed address.

This is a guarantee about **copies** (dumps, backups, a leaked file). It is not a guarantee against
someone who can **run code or write rows** in the live system — the Worker's own secrets and
bindings are available to any code deployed as the Worker, which is why deploy rights are a
security boundary of their own (see "Who can change what").

## Who is trusted

- **Cloudflare**: holds the databases and the keys; can read everything.
- **The mail service, for authentication.** A sign-in link is a bearer token that travels through
  SMTP2GO to the participant's mailbox. Whoever can read outgoing mail at the provider, or the
  mailbox itself, can sign in as that participant until the link expires (20 minutes for sign-in,
  24 hours for registration). This is inherent to every email-link login, including the managed
  providers considered earlier; the controls are short expiry, single use, the confirmation page
  that names the account and flags a link opened elsewhere, separate API credentials for sign-in
  mail and announcements, two-factor on the SMTP2GO account, minimal log retention and no content
  archiving at the provider. A factor independent of email (passkeys for participants) would
  remove this dependence; it is not built.
- **Whoever can deploy code** (owner's GitHub account, the Cloudflare API token in GitHub).

## Flows

**Register.** `/register/`: name, email, affiliation (optional), two optional list checkboxes.
The Worker creates the identity as *pending* (or finds it), issues a token and mails the link
through SMTP2GO, and stores the profile in `pending_profiles` with a 24-hour expiry. Nothing else is granted.
The link opens `/account/verify`, which shows a **Continue** button: the token is only exchanged on
that POST, so mail scanners that prefetch links cannot consume it. On success the identity becomes
*active* and a session is opened; the profile moves to `users`; the visitor is sent back to
what they opened (`/go/…`) or to `/account/`.

**Sign in.** `/signin/`: email only. Existing users get a sign-in link (60 min). An unknown address
gets a registration link and, after verifying, a short profile form. No enumeration: the
"check your email" page is the same either way.

**Protected links.** Public pages link to `/go/join/<slug>/` and `/go/recording/<slug>/`. The Worker
validates the session on every request (and slides it), checks the account exists, decrypts the
URL from `afflux_links`, and redirects. Anyone else sees the gate page; the
destination is never in the HTML.

**Account.** `/account/`: name, affiliation, the two toggles (no confirmation email), sign out,
sign out everywhere, delete account (removes the profile, the identity, its tokens and sessions).

**Programme editor.** `/admin/talks` (behind Access like the rest of the admin): one form per talk
with the fields of the brief — speaker, affiliation, photo, date, time, language, title EN/RU,
abstract EN/RU, bio EN/RU, Zoom URL, recording URL, slides, minutes. Public fields are written to
the content repository as `data/talks/<slug>.json` (photo to `photos/`, uploaded documents to
`files/`) through the GitHub Contents API with `GITHUB_CONTENT_TOKEN`, a fine-grained token limited
to that repository (Contents: read and write); the site rebuilds from the repository within minutes.
The Zoom and recording URLs go to the encrypted links store, never to GitHub; the public `join` and
`recording` flags follow what is stored. Uploads are checked by name, size and magic number; a
stale edit (the file changed meanwhile) is refused with the file's sha, never overwritten.
A compromise of this token can change the programme text and files, not the code or the keys.

**Comments and suggestions.** `/account/feedback` (signed in, profile complete): a subject and a
plain-text message, mailed by the Worker to the seminar address (`FEEDBACK_TO` if set, otherwise
the address in `MAIL_FROM`) with the participant's name, affiliation and address, and the
participant's address as `Reply-To`. Five messages an hour per account on top of the generic
limit; control characters removed; nothing is stored — the message exists only in the mail.

**Announcements.** `/admin/announce` (behind Access; "Announce this session" prefills it from the
programme): choose the list, subject and text, preview, confirm. The confirmation carries an
idempotency key bound to the payload, so a double click creates one job and a reused key with a
different text is refused. The job is created in state `initializing` with a stored snapshot of
the recipient ids; the recipient rows are written in batches and the job becomes `running` only
when all of them exist — resubmitting the confirmation completes an interrupted list instead of
hiding it. Nothing is sent until the operator presses **Start**; from then on the page resubmits
itself while it stays open (closing it pauses the job). Each POST atomically claims up to 20
pending recipients under a fresh attempt id (one statement), rechecks their current preference
(one query), decrypts addresses for that send only, and records `sent`, `failed` (rejected by
the service), `unknown` (no answer within 20 s) or `skipped` (unsubscribed meanwhile) in one
batch — a completion from an older attempt cannot touch a row a newer attempt owns. A claim older
than 15 minutes becomes `unknown`. Nothing is retried on its own; "Retry failed" and "Retry failed
and unknown" are explicit decisions, the latter accepting possible duplicates. Each message carries
`List-Unsubscribe` with a signed 60-day token; the one-click endpoint switches that list off.

**Recordings.** Sessions are streamed live from Zoom to YouTube ("Live on YouTube", unlisted).
The stream is scheduled in YouTube Studio in advance, so its URL exists before the session; the
secretary pastes it into `/admin/links` as the recording link together with the Zoom link. When the
stream ends, YouTube keeps it as a video at the same URL and "Watch the recording" works without
any further step. Nothing is uploaded and nothing is downloaded.

**Confirmation page.** The emailed link is answered with a redirect that moves the token out of the
address into a signed five-minute cookie, so no Referer, history entry or asset request carries it;
the page then names the account (masked address) and says whether this is the browser that asked
for the link. The form carries a keyed commitment to that token: a page left open while another
link landed in the same browser cannot confirm the newer token — it is answered with the newer
account's page instead, and nothing is consumed. The token is consumed only on the POST behind the
button, which is refused when the browser is already signed in to a different account. Expiry is
compared with the database's clock at the moment of the claim. `LINK_BINDING = "strict"` additionally refuses a
link opened in any browser other than the one that asked (default `warn`: allowed, with the warning).

Each recipient's preference is checked twice: once for the chunk (to decide what to decrypt) and
once immediately before that recipient's own send; a completion from a finished chunk is one
conditional statement, so an explicit retry cannot be overtaken by a stale completion.

**Daily job** (`17 4 * * *`): deletes unverified identities and profiles past their 24 hours,
spent and expired tokens, dead sessions; purges throttle counters.

## Setting up (all in web dashboards; no terminal needed)

1. **Cloudflare.** D1 → create `afflux_identity`, `afflux_users`, `afflux_links` with the location
   hint *Western Europe* (`weur`); paste the ids into `wrangler.toml`; apply the three migration files
   in each database's console (or `npm run migrate`). The first deploy comes from the GitHub workflow
   (API token from the "Edit Cloudflare Workers" template, limited to this account and this zone, no
   D1 permission) and creates the Worker and its custom domain. Passkeys on the account, recovery
   codes on paper.
2. **Secrets** (Worker → Settings → Variables and Secrets): `SIGNING_KEY`, `INDEX_KEY`, `DATA_KEY`
   — three different random 32-byte values, base64 (`tools/keygen.html` in a browser, or
   `openssl rand -base64 32`); `GITHUB_CONTENT_TOKEN` (GitHub → Settings → Developer settings →
   Fine-grained tokens: repository access = the content repository only, permission Contents:
   read and write, the longest expiry offered; renew it when it expires); `SMTP2GO_API_KEY`
   and, from a second SMTP2GO API key, `SMTP2GO_API_KEY_AUTH`. Keep offline copies of `DATA_KEY`
   and `INDEX_KEY`: without them the encrypted fields and the address index are gone for good.
   Keys must be secrets, never `[vars]`.
3. **SMTP2GO.** Starter plan. Verify the sending domain (they guide you through SPF and DKIM),
   create an API key restricted to "send email", set log retention to the minimum, keep content
   storage off. `MAIL_FROM` in `wrangler.toml` must be an address on the verified domain.
4. **Mail in.** Cloudflare → Email → Email Routing: `seminar@<domain>` → the mailbox you read.
   Replies from a mail client through SMTP2GO's SMTP (`mail.smtp2go.com`, port 587, an SMTP user).
5. **Cloudflare Access.** A self-hosted application for `https://<domain>/admin`, policy "allow"
   for your identity provider with MFA/passkeys enforced there; copy the team domain and the
   application audience tag into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Without both, `/admin`
   answers 403 on a deployed Worker.
6. **Rate limiting.** Security → WAF → one rate-limiting rule covering both `/api/*` and
   `/ru/api/*`, e.g. 30 requests per minute per IP. The Worker's own atomic per-address and
   per-client counters are the second line.
7. **Logs.** `[observability] enabled = false` stays in `wrangler.toml`; do not enable Workers Logs,
   Logpush or tail workers on this Worker: request logs record URLs, and sign-in links carry
   their token in the URL. Confirm in staging with a canary link that no log product shows it.
8. **Deploy.** The workflow in the code repository builds the site from the content repository
   and deploys. Its Cloudflare API token comes from the "Edit Cloudflare Workers" template limited
   to this account and zone (Workers scripts, routes and custom domains); it must not have D1 or
   account-wide rights — migrations are run by a person.

## Who can change what

Two repositories, two circles of people:

- **afflux-site** (this code): the Worker, the build, the workflow. Push access: the owner only,
  protected `main`, passkeys. Whoever can push here can deploy code that reads the databases with
  the Worker's own secrets — this is the real root of trust, equal to the Cloudflare account.
- **afflux-content**: `data/talks/*.json`, `photos/` and `files/`, public. The secretary edits it
  through the admin's programme editor (the Worker writes with a token limited to this repository);
  GitHub's own editor works too. A change here only triggers a rebuild of the public pages; it
  cannot change what the Worker does.

The Worker admin (`/admin`, behind Access) and the CMS are therefore separate surfaces with
separate rights: links and announcements on one side, programme text on the other.

Before go-live: test the whole flow from a Russian network without VPN and from abroad; check the
headers of a received message for SPF, DKIM and DMARC passes.

## Local development

```
npm install
cp .dev.vars.example .dev.vars.dev
npm run migrate:local
npm run mock            # SMTP2GO stand-in on :9101 (prints magic links)
npm run dev             # http://localhost:8788, admin without Access (DEV_ADMIN_BYPASS, localhost only)
python3 test/e2e.py     # 52 end-to-end checks incl. the audit reproductions; exits 1 on any failure
```

The static site must be built (`node ../build.mjs`) so `/assets/*` resolve. The daily job can be
triggered with `curl "http://localhost:8788/__scheduled?cron=17+4+*+*+*"`.

## Security notes

- Every POST except one-click unsubscribe requires a same-origin `Origin`/`Sec-Fetch-Site`; cookies
  are `HttpOnly; Secure; SameSite=Lax`. The return path after sign-in is allow-listed to this site.
- Responses carry the same CSP and headers as the static site, plus `Cache-Control: no-store`.
- Key rotation (rehearsed by `test/rotation.py --disposable 600`): `SIGNING_KEY` can be
  replaced at any time — signed cookies and unsubscribe links issued before it stop verifying;
  sessions are *not* affected (they are random tokens), so revoke them from `/admin/maintenance`
  if the key was exposed. `INDEX_KEY` and `DATA_KEY` rotate with their `_PREVIOUS` counterpart set
  during the migration. A **key-generation fence** (table `meta` in each database) makes the
  procedure safe against requests still running on the old configuration: every encrypted write is
  conditioned on the fence holding the writer's key generation; the first write of the new
  generation advances the fence (allowed only along the configured previous → current chain), and
  from that moment a request that still has the old key as current writes nothing and gets a 503.
  The maintenance page shows the fence and exactly how many rows, across all stores, are still on
  another key (the index and every ciphertext carry a key fingerprint); Reindex / Re-encrypt run in
  bounded passes with compare-and-swap writes, so a participant editing their profile meanwhile is
  never overwritten. Only when both counters are 0 is the previous value removed from the
  configuration — and its offline copy is kept for as long as any backup made under it exists.
  A rollback to a configuration whose current key is behind the fence is likewise refused.
- Schema version 2 is for a fresh installation: nothing was ever deployed on version 1. If a
  version-1 database did exist, its address index was keyed by `SIGNING_KEY` in an unprefixed
  format; the code still recognises that format when the old key is supplied as
  `INDEX_KEY_PREVIOUS`, but the `sends`, `tokens` and `send_targets` tables would need an
  incremental migration that is not provided.
- The identity module has the same interface a managed provider would; swapping back to one is a
  matter of replacing `src/identity/local.js`.
- What the application itself logs: on an unhandled error, a short error code (`E_DECRYPT`,
  an HTTP status) and nothing else — never a message, an address, a name or a token. Platform
  invocation records (method and URL) are a separate product and are disabled in `wrangler.toml`;
  Logpush, tail workers and any other sink must stay off, which the staging checklist verifies
  with a canary link.
- Query budget: one 20-recipient request is about 35 database calls (claim, preference checks,
  one per-recipient recheck, one batch of outcomes, the fence) and 20 mail requests; the
  maintenance passes are 100 rows each. Verify both against the limits of the chosen Cloudflare
  plan on staging before relying on the chunk size.
- GET and HEAD never send mail and never consume a token. They do have two intended effects:
  a session that is due for renewal is extended (and its cookie re-issued), and the magic-link
  landing sets the confirmation cookie.
