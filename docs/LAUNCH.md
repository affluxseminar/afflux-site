# Launch plan

Order of operations for one person doing everything, from Moscow, honestly (no VPN, real details).

**24 October 2026 — new name and domain.** The seminar is EEES (Economics of Energy and
Environment Seminar); the site moved to eeeseminar.org (bought in Cloudflare Registrar), the admin
to admin.eeeseminar.org, the address to seminar@eeeseminar.org. affluxseminar.org and .com answer
with 301s to the same path (step "retire" of `tools/cf-setup.mjs`); seminar@affluxseminar.org still
forwards. The text below keeps the former domain where it describes what was done then.

**13 October 2026 — where things stand.** The site is live at affluxseminar.org as an open site
without registration (see README "Status" and ADR-001, last amendment). Hosting changed after the
first day: Cloudflare-proxied pages are throttled in Russia (section 0 below was wrong about that),
so the public site is on GitHub Pages and only the admin (admin.affluxseminar.org) stays on
Cloudflare. Steps 2 and 3 below that concern registration, SMTP2GO and the six Worker secrets are
no longer needed for launch: SMTP2GO only if announcements are to be sent "as" seminar@ from Gmail.

## 0. Where to host — decide first, test before paying

Since June 2025 Russian providers throttle connections to many foreign networks: Cloudflare,
Hetzner, OVH, DigitalOcean and, by February 2026, hundreds of other foreign autonomous systems
(Amazon, Akamai, Oracle, Scaleway, Vultr, Contabo …). A throttled connection delivers roughly the
first 16 KB and then hangs; the lists differ by provider and change without notice; domain-level
exceptions exist but are not something a small site can apply for. Nobody outside Russia can
promise "reachable in Russia without VPN". What can be done:

1. Measure, don't assume: from home broadband and from two mobile networks, without VPN, open a
   few sites known to be on each candidate network (a Cloudflare-proxied site, a Hetzner-hosted
   site, …) and see whether they load completely. Repeat the test with the staging site before
   launch (TEST-CHECKLIST, "Reachability").
2. Keep the site movable, which it is: the public site is static files; the application is one
   small program with web-standard interfaces and three SQLite-compatible databases. Moving it
   to a plain virtual server (Node, SQLite files, system cron) is a day of work and is planned as
   a variant if Cloudflare proves throttled on the audience's networks. Only two things are
   Cloudflare-specific and would need replacing: the admin gate (Cloudflare Access) and D1.
3. Accept the trade-off if it comes to it: the site will be equally reachable from Russia only
   from a host whose network is not on the lists at the time — and that can change. The honest
   fallback for a Russian audience is hosting in Russia, which was excluded by decision.

Recordings: YouTube is throttled in Russia since 2024; a viewer in Russia will need VPN for the
recording regardless of where the site lives. The recording link accepts other hosts
(`LINK_HOSTS`), so a second host can be added later without touching the site.

Decision of 2026-10-12: Cloudflare, after measurements from the audience's own networks (MTS mobile
over IPv6 and a Moscow home line over IPv4 both completed 10 MB transfers to speed.cloudflare.com).
A Russian-language, click-by-click version of this plan lives in the project doc "AFFLUX: запуск по
шагам"; this file is the technical summary.

## 1. Accounts (one evening)
- Cloudflare account (foreign card is fine), domain affluxseminar.org bought in Cloudflare Registrar,
  Email Routing enabled. Passkey sign-in, recovery codes on paper, a second passkey on another device.
- GitHub account `affluxseminar` with a passkey (two-factor sign-in): the account is the only
  thing that can change the code or run a deploy, so its sign-in is the protection. Two
  repositories, both done on 12 Oct 2026: the code (`afflux-site`, private; environment
  "production" limited to `main`; repository variables CONTENT_REPO and SITE_URL) and the
  content (`afflux-content`, public, no secrets). GitHub does not enforce branch rulesets on a
  private repository of a free personal account, so `main` has none; if the repository is ever
  made public or the account upgraded, add a ruleset on `main`: restrict deletions, block force
  pushes. A fine-grained GitHub token limited to
  the content repository (Contents: read and write) for the admin's programme editor — the
  secretary never opens GitHub.
- SMTP2GO account, Starter plan; verified sending domain; API key; log retention at the minimum.
- Reading mailbox outside Russian providers (Gmail is fine as a window — see docs/DNS.md).
- YouTube channel with live streaming enabled (phone verification, 24-hour wait — do this early).

## 2. DNS and mail (one hour)
Records from docs/DNS.md. Then request a sign-in link on the site and check it arrives and passes
SPF, DKIM and DMARC (the message headers show it).

## 3. Deploy (one hour)
server/README.md → "Setting up": three D1 databases (Western Europe) and migrations, the API token
and account id as GitHub secrets, first deploy from the workflow, the six Worker secrets
(`tools/keygen.html` for the three random ones; `GITHUB_CONTENT_TOKEN`; the two SMTP2GO keys), Cloudflare Access on /admin, rate-limiting rule on
/api/*. A separate staging deployment is optional for a one-person operation: the production domain
is unknown to the audience until step 6 and serves as the test site; delete the test accounts after.

## 4. Checks from the audience's side (half a day)
From a Russian network without VPN and from abroad: open the site, register, receive the link,
open it, be returned to a protected link. Check the mail headers for a Gmail, an Outlook and a
Mail.ru recipient.

## 5. Content
Real conveners' texts confirmed; first talks in talks.json with `join: true`; their Zoom links
and the pre-scheduled YouTube stream URLs in /admin/links.

## 6. Moving the audience (two weeks)
- One final letter from the old mailing address: the seminar has moved to the new site; to receive
  announcements and the joining link, register — one email, no password; add seminar@<domain> to
  contacts. Repeat once to those who have not registered.
- Then delete the old address list everywhere (mailbox contacts, spreadsheets, sent folders) and
  set an auto-reply on the old mailbox pointing to the new address. The old mailbox is not used
  for the seminar's correspondence from that point on.

## 7. Running
Weekly: talk in talks.json → links in /admin/links → "Announce this session" → send. After the
session nothing to do: the stream URL is the recording.
