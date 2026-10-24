# EEES — site

EEES (Economics of Energy and Environment Seminar) is the seminar's name since 24 October 2026;
until then it was AFFLUX. Repository, Worker, database and cookie names keep `afflux`: they are
internal, and the former domains (`affluxseminar.org`, `.com`) answer with 301s to the same path on
`eeeseminar.org`.

Static, bilingual (EN at `/`, RU at `/ru/`), data-driven. One JSON file per seminar holds the
programme; a dependency-free build script renders every page. The public pages make no third-party
requests and keep nothing about their visitors.

**Status, 13 October 2026 — the open site.** The owner decided that the site collects no personal
data at all: no registration, no accounts, no mailing list on the site (Russian law on the
localisation of personal data and on sign-in methods made the account-based design untenable for
a seminar run from Russia with this audience). The link to join and the recording are public
fields of each talk, shown to everyone; the meeting itself does not start before its host
(Zoom settings). Announcements go out from the seminar's own mailbox; the Subscribe page tells
people to write to it. The public site is served by GitHub Pages at `eeeseminar.org`
(reachable from Russia, where Cloudflare-proxied sites are throttled); the Worker in `server/` is
the admin only, at `admin.eeeseminar.org`, with `REGISTRATION = "closed"`. The registration,
sign-in and announcement code described further down is dormant, kept for a future that can host
it lawfully; `docs/ADR-001-identity-and-access.md`, amendment of 13 Oct 2026, records the decision.

```
data/site.json        settings, conveners, every UI string in both languages, the About text (defaults)
src/texts.js          which of those texts the admin's Texts page may change, and how data/site-texts.json
                      from the content repository is checked and merged over the defaults
data/talks/           the programme — one JSON file per seminar, written by the admin's editor (or by hand)
src/render.js         templates, shared by the build and the single-file preview
src/style.css         the visual system: three appearances, type, grid
src/client.js         optional enhancements: appearance control, local time, live status
build.mjs             node build.mjs  →  dist/
assets/fonts/         self-hosted fonts (OFL licences alongside)
photos/               speaker portraits, referenced by file name from talks.json
files/                slides and minutes (PDF, PPT, PPTX), referenced by file name from talks.json
content-repo-template/  the separate CONTENT repository: talks.json, photos, files, the CMS — see "Two repositories"
server/               registration, sign-in, protected links, announcements (Cloudflare Worker)
docs/                 architecture decisions
tools/stress.mjs      layout stress build with synthetic strings → dist-stress/ (never deployed)
tools/keygen.html     generates the three server secrets in the browser (opens locally, no network)
.github/workflows/    build on push and nightly, deploy site + server with wrangler
```

Build: `node build.mjs` (Node 18+). Output goes to `dist/` and nothing else is needed on the server.
`node build.mjs --preview` additionally writes `preview/afflux-preview.html`, the whole site in one
file with client-side routing, for design review only. `node tools/stress.mjs` renders the site
with synthetic, deliberately awkward content into `dist-stress/` for layout checks.

## Adding a seminar

Add one object to the top of the `talks` array in `data/talks.json` and commit. Everything else —
the front page, Upcoming, the talk's page in both languages, the Archive, sitemap, OpenGraph tags,
JSON-LD — is generated.

```json
{
  "number": 1,
  "slug": "2026-10-15-surname",
  "speaker": "Name Surname",
  "affiliation": "University of Somewhere",
  "photo": "surname.jpg",
  "date": "2026-10-15",
  "time": "17:00",
  "language": "en",
  "title":    { "en": "…", "ru": "…" },
  "abstract": { "en": "…", "ru": "…" },
  "bio":      { "en": "…", "ru": "…" },
  "zoom": "https://us06web.zoom.us/j/…?pwd=…",
  "video": "https://www.youtube.com/watch?v=…",
  "slides": "",
  "minutes": ""
}
```

`zoom` is the public invitation link (the build accepts only `https://…zoom.us/…`); the Join button
shows while it is set and the session has not ended. `video` is the recording (any `https://`
address); the Recording button and the archive link show while it is set. Normally the secretary
never sees these files: the admin's programme editor (`/admin/talks`) writes
`data/talks/<slug>.json`, the photo and the documents to the content repository from one form.

The build validates every entry and stops with a plain message otherwise: `slug` unique, letters,
digits, dots and hyphens; `date` as `YYYY-MM-DD`; `time` as `HH:MM` Moscow time (add `"timezone"`
to override); `language` `en` or `ru`; a title in at least one language; `photo` a file name in `photos/`;
`slides` and `minutes` either an `https://` address or the name of a file in `files/`
(`"minutes.pdf"` or `"/files/minutes.pdf"`, as the CMS writes it). The archive row and the talk
page show Recording, Slides and Minutes links for whatever is present.

- `speaker` and `affiliation` may be a plain string or `{ "en": …, "ru": … }` when a transliteration is wanted.
- Missing RU (or EN) text falls back to the other language, marked with the correct `lang` attribute.
- Portraits are shown in black and white; without a photo the page shows a plate with initials.
- The Join button appears until the session ends, Recording and Slides afterwards; each only when
  its field is filled, so there are no empty buttons.
- Blank lines in `abstract` and `bio` become paragraphs. An optional `"summary": { "en", "ru" }`
  replaces the automatic synopsis shown on the front page.

With no entries the site shows "Programme forthcoming" and an empty archive; nothing is invented.

Past seminars move to the Archive at the next build. The workflow rebuilds whenever the programme
changes (polled every 10 minutes), and `client.js` retires the join link the moment a session ends,
before the rebuild.

## The site's own texts

The About page, the conveners' names and credentials, and the short texts of the masthead, footer,
programme pages and Subscribe page are edited in the admin (`/admin/texts`, two languages side by
side) and saved to the content repository as `data/site-texts.json`. The build checks that file
(`src/texts.js`: only the listed fields, length limits, paragraphs and credential lines as plain
strings) and merges it over the defaults in `data/site.json`; an empty field means the default.
A broken file stops the build, so the live site never shows half a change. Everything else in
`data/site.json` — button labels, error texts, the figure caption — is changed in this repository.

## Two repositories

The programme is public and changes weekly; the code changes rarely and can read the databases.
They live in different repositories with different people allowed to push:

- **afflux-content** (from `content-repo-template/`): `data/talks/`, `data/site-texts.json`, `photos/`, `files/`, and the CMS
  (`admin/`, Decap, pinned and hash-verified, deployed as its own tiny site). The secretary edits
  here, through the form or GitHub's editor. Pushing here only triggers a rebuild of the pages.
- **afflux-site** (this repository): templates, build, Worker, deploy workflow. The owner only,
  protected `main`. The workflow checks out the content repository and builds from it.

A compromised CMS login can change the programme text and nothing else: the build treats the
content repository as untrusted input (only regular image files inside `photos/` and regular
PDF/PPT files inside `files/`, no symbolic links, no unexpected files, `talks.json` validated), the workflow checks it out without keeping
credentials, and the live site's `content-version.txt` — not a cache — tells the workflow what is
deployed. A compromised owner account can change everything — which is why that account has
passkeys and nothing else.

## Registration, protected links, announcements (dormant since 13 Oct 2026)

This section describes the account-based mode, switched off on the live site (`REGISTRATION =
"closed"` in `server/wrangler.toml`; see the status note at the top). In that mode joining a
session and watching a recording require a free account: registration by magic link,
no password. The two announcement lists (English-language sessions, Russian-language sessions) are
optional checkboxes on the same form and toggles on the account page. The static site knows nothing
about accounts: it only links to `/go/join/<slug>/`, `/go/recording/<slug>/` and `/register/`,
which the server in `server/` handles. Addresses, names, affiliations and the protected URLs are
encrypted at rest with a key that lives only in the Worker's secrets; the databases key everything
by an opaque id. Details and setup: `server/README.md`.

## Appearance

Three appearances, all built from the same tokens at the top of `src/style.css`:

- **Deep** (default) — midnight blue-black, muted text, a spectral cyan-green accent used only for
  links, focus, the accented streamlines and hover.
- **Dark** — a comfortable navy.
- **Light** — low-glare stone, no white; the accent becomes a deep teal for contrast.

First visit follows `prefers-color-scheme` (light → Light, otherwise Deep). The three-dot control in
the header overrides it instantly, without reload, and the choice is kept in `localStorage`
(`afflux-theme`) — no account, no cookie, nothing sent anywhere. A ten-line inline script applies the
saved choice before first paint so the page never flashes; its hash is in the CSP. Without JavaScript
the control is hidden and the system preference applies. All three pass WCAG AA for body text, links
and interface elements.

## Security notes for deployment

The site is static files. There is no runtime, no form handler, no analytics, no cookies, and the
only outbound request a visitor's browser makes is the subscription form's POST to the provider.

- **Headers.** `dist/_headers` (Netlify, Cloudflare Pages) sets a strict Content-Security-Policy
  (`default-src 'none'`; scripts, styles, fonts and images from the site's own origin only; the one
  inline script allowed by hash; `form-action` limited to the newsletter provider;
  `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`, COOP/CORP and HSTS. Every page also carries the same CSP
  in a `<meta>` tag, so hosts that ignore `_headers` (GitHub Pages) still enforce it, except
  `frame-ancestors`, which cannot be expressed in `<meta>`. Enable HSTS only once HTTPS is confirmed
  working on the final domain; then consider preloading.
- **Secrets.** None exist in the project. Deployment credentials live in GitHub's secrets (a
  Cloudflare token scoped to Workers Scripts: Edit), the Worker's keys in its secret bindings, the
  CMS's OAuth secret in its sign-in service.
- **Zoom and recording links** are never in the repository, the build output or any page: they
  live in a separate database read only by the server after it has verified a session.
- **Dependencies.** The public site: none. Build: Node only. Server: none at runtime, `wrangler`
  to deploy; the only external services are Cloudflare and SMTP2GO. Admin (CMS): one pinned,
  hash-verified file. Fonts: self-hosted subsets of two OFL typefaces, licences included.

## Deployment

`.github/workflows/build.yml` builds the site from the content repository, runs the server's
end-to-end checks, publishes `dist/` to GitHub Pages (the public site, custom domain
`eeeseminar.org`, HTTPS enforced — Settings → Pages, source "GitHub Actions") and deploys the
Worker (the admin, `admin.eeeseminar.org`) with two repository secrets (`CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`). It runs on push, on demand, and every 10 minutes when the programme
changed. DNS, Cloudflare Access on the admin and the rest of the Cloudflare side are set by
`tools/cf-setup.mjs` (the "Cloudflare setup" workflow). The static site alone works on any static
host.

Before going live, set in `data/site.json`: `baseUrl` (canonical URLs, hreflang, sitemap, OpenGraph)
and `email`; then follow `server/README.md` → "Setting up".

## What the build produces for search and sharing

Per page: `<title>`, description, canonical URL, `hreflang` alternates (en, ru, x-default),
OpenGraph and Twitter card tags with `assets/og-default.png` (1200×630, the wordmark and the field on
the deep background; it, the icons and the YouTube channel's pictures are drawn by
`tools/brand-images.py`), `theme-color`. Per talk: a `schema.org/Event` JSON-LD block with start and end
time, online attendance, speaker and organiser, and the recording as `recordedIn` when present.
Plus `sitemap.xml` with hreflang pairs, `robots.txt`, `404.html` and `ru/404.html`.

## Visual system

- **Type.** Old Standard TT for the wordmark, titles and dates — a scholarly nineteenth-century face
  with a proper Cyrillic, so the same voice carries both languages. Golos Text, a Cyrillic-native
  grotesk in the Swiss tradition, for everything else. Both self-hosted as Latin + Cyrillic subsets
  (about 115 kB together), preloaded, `font-display: swap`. No icons.
- **Reading.** Abstracts and biographies are set at a fluid 17–19 px, 1.68 leading, a measure of
  70 characters, in a slightly softened text colour so long reading on the deep background is calm.
- **Grid.** Twelve columns. Sections are a marginal label plus a body column, like a journal's
  sidenotes; on tablets the label column widens, on phones it stacks. Lists of talks are ledgers with
  hairlines, not cards. Left-aligned throughout.
- **Identity.** The wordmark EEES is set justified across the full measure, so the four letters are
  the grid; under each, in italic, the word it stands for (Economics, Energy, Environment, Seminar).
  The only illustration is Fig. 1: streamlines of a point sink (a flowing towards), computed from a small vector field in `src/field.js`, shared by the build, the server pages and
  the live version; every fourth trajectory carries the accent.
- **Accessibility.** Landmarks, skip link, visible focus in every appearance, `aria-current` on
  navigation, native radio buttons behind the appearance control, `lang` on fallback text, form
  labels, print styles.
