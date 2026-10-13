#!/usr/bin/env node
/* AFFLUX static build.
   Reads data/site.json and data/talks.json, renders every page in EN (/) and RU (/ru/),
   copies assets, writes sitemap, robots, security headers and the not-found pages.
   No dependencies: Node 18+ only.

   node build.mjs                 → dist/
   node build.mjs --preview       → also preview/afflux-preview.html (one file, client-side routed; never deployed)
   node build.mjs --content DIR   → DIR is the content repository's root: DIR/data/talks/*.json (one file per
                                    seminar, written by the admin's talk editor), DIR/photos/ and DIR/files/
                                    (the deploy workflow checks that repository out; programme editors never
                                    need write access to the code repository). A legacy DIR/data/talks.json
                                    is read as well.
   node build.mjs --talks FILE --out DIR   (used by tools/stress.mjs) */

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync, lstatSync, copyFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_INIT, THEME_INIT_HASH, cspPolicy, SECURITY_HEADERS } from './src/shared.js';
import { FIELD, streamlineSvg, fieldAttrs } from './src/field.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

const OUT = opt('--out', join(HERE, 'dist'));
const CONTENT = opt('--content', null);
const CONTENT_SHA = opt('--content-sha', '');
const TALKS_FILE = opt('--talks', CONTENT ? join(CONTENT, 'data/talks.json') : join(HERE, 'data/talks.json'));
const TALKS_DIR = opt('--talks', null) ? null : (CONTENT ? join(CONTENT, 'data/talks') : join(HERE, 'data/talks'));
const PHOTOS_DIR = CONTENT ? join(CONTENT, 'photos') : join(HERE, 'photos');
const FILES_DIR = CONTENT ? join(CONTENT, 'files') : join(HERE, 'files');

/* The content repository is a different trust level from this code: nothing from it is copied
   unless it is a regular file (no symbolic links, no devices), named like an image, and located
   inside the photos directory after resolving the real path. Anything else stops the build. */
const PHOTO_NAME = /^[A-Za-z0-9._-]+\.(jpe?g|png|webp|avif)$/i;
const FILE_NAME = /^[A-Za-z0-9._-]+\.(pdf|pptx?)$/i;     // slides and minutes placed in files/
const docName = (u) => String(u || '').replace(/^\/?files\//, '');
function safeContentFile(dir, name, pattern, maxMb, what) {
  if (!pattern.test(name) || name.startsWith('.')) return null;
  const p = join(dir, name);
  const st = lstatSync(p);
  if (st.isSymbolicLink()) throw new Error(`content: ${name} is a symbolic link; refused`);
  if (!st.isFile()) throw new Error(`content: ${name} is not a regular file; refused`);
  if (st.size > maxMb * 1024 * 1024) throw new Error(`content: ${name} is larger than ${maxMb} MB; refused`);
  const real = realpathSync(p), base = realpathSync(dir);
  if (!real.startsWith(base + '/')) throw new Error(`content: ${name} resolves outside ${what}/; refused`);
  return p;
}
const safePhoto = (dir, name) => safeContentFile(dir, name, PHOTO_NAME, 8, 'photos');
const safeFile = (dir, name) => safeContentFile(dir, name, FILE_NAME, 40, 'files');
const NOW = process.env.BUILD_NOW ? new Date(process.env.BUILD_NOW) : new Date();

const site = JSON.parse(readFileSync(join(HERE, 'data/site.json'), 'utf8'));
const talks = [];
if (existsSync(TALKS_FILE)) {
  if (lstatSync(TALKS_FILE).isSymbolicLink()) { console.error('content: talks.json is a symbolic link; refused'); process.exit(1); }
  const talksFile = JSON.parse(readFileSync(TALKS_FILE, 'utf8'));
  talks.push(...(Array.isArray(talksFile) ? talksFile : (talksFile.talks || [])));
}
/* One file per seminar: data/talks/<slug>.json, written by the admin's editor (or by hand). The file
   name is the slug; the same boundary rules as for photos apply. */
if (TALKS_DIR && existsSync(TALKS_DIR)) {
  if (lstatSync(TALKS_DIR).isSymbolicLink()) { console.error('content: data/talks is a symbolic link; refused'); process.exit(1); }
  for (const f of readdirSync(TALKS_DIR)) {
    if (/\.(txt|md)$/i.test(f) || f.startsWith('.')) continue;
    if (!/^[A-Za-z0-9._-]+\.json$/.test(f)) { console.error(`content: unexpected file in data/talks/: ${f}`); process.exit(1); }
    const p = join(TALKS_DIR, f), st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 512 * 1024) { console.error(`content: ${f} refused (symbolic link, not a regular file, or over 512 kB)`); process.exit(1); }
    let t;
    try { t = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { console.error(`content: data/talks/${f} is not valid JSON: ${e.message}`); process.exit(1); }
    if (!t || typeof t !== 'object' || Array.isArray(t)) { console.error(`content: data/talks/${f} must contain one seminar object`); process.exit(1); }
    const slug = f.replace(/\.json$/, '');
    if (t.slug && t.slug !== slug) { console.error(`content: data/talks/${f}: "slug" must equal the file name (${slug})`); process.exit(1); }
    talks.push({ ...t, slug });
  }
}

const css = readFileSync(join(HERE, 'src/style.css'), 'utf8');
const clientJs = readFileSync(join(HERE, 'src/client.js'), 'utf8');
const renderSrc = readFileSync(join(HERE, 'src/render.js'), 'utf8');

await import(join(HERE, 'src/render.js'));
const R = globalThis.AFFLUX;

/* ---------- validation (fail loudly on the secretary's behalf) ---------- */

const errors = [];
const seen = new Set();
for (const t of talks) {
  const id = t.slug || `#${t.number}`;
  if (!t.slug || !/^[A-Za-z0-9._-]+$/.test(t.slug)) errors.push(`${id}: slug must be letters, digits, dots, hyphens`);
  if (seen.has(t.slug)) errors.push(`${id}: duplicate slug`);
  seen.add(t.slug);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) errors.push(`${id}: date must be YYYY-MM-DD`);
  if (!/^\d{2}:\d{2}$/.test(t.time || '')) errors.push(`${id}: time must be HH:MM`);
  if (!['en', 'ru'].includes(t.language)) errors.push(`${id}: language must be "en" or "ru"`);
  if (!t.title || (!t.title.en && !t.title.ru)) errors.push(`${id}: title.en or title.ru is required`);
  if (!t.speaker) errors.push(`${id}: speaker is required`);
  // Slides and minutes: an https address, or a file placed in files/ (pdf, ppt, pptx), given as "name.pdf" or "/files/name.pdf".
  const isDoc = (u) => !u || /^https:\/\/[^\s"'<>]+$/.test(u) || FILE_NAME.test(docName(u));
  if (!isDoc(t.slides)) errors.push(`${id}: slides must be an https:// address or a file name in files/`);
  if (!isDoc(t.minutes)) errors.push(`${id}: minutes must be an https:// address or a file name in files/`);
  // Zoom and recording URLs never enter the public data: only booleans that switch the buttons on.
  for (const k of ['join', 'recording', 'zoom']) {
    if (typeof t[k] === 'string' && t[k]) errors.push(`${id}: "${k}" must not contain a link — protected URLs are entered in the server admin, not in talks.json`);
  }
  if (t.photo && !/^[A-Za-z0-9._-]+\.(jpe?g|png|webp|avif)$/i.test(t.photo)) errors.push(`${id}: photo must be a file name in photos/ (jpg, png, webp, avif)`);
}
if (!/^https:\/\/[^/]+$/.test(site.baseUrl || '')) errors.push('site.json: baseUrl must be https://host with no path');
if (errors.length) {
  console.error('Build stopped:\n  ' + errors.join('\n  '));
  process.exit(1);
}

/* ---------- the figure (src/field.js) ---------- */
const fieldSvg = streamlineSvg(FIELD);
const fieldLiveJs = readFileSync(join(HERE, 'src/field-live.js'), 'utf8');

/* ---------- security: CSP with a hash for the one inline script ---------- */

const themeHash = 'sha256-' + createHash('sha256').update(THEME_INIT, 'utf8').digest('base64');
if (themeHash !== THEME_INIT_HASH) { console.error(`src/shared.js: THEME_INIT_HASH is stale; expected ${themeHash}`); process.exit(1); }
const CSP_META = cspPolicy();
const CSP_HEADER = cspPolicy({ header: true });

/* ---------- page assembly ---------- */

const urlFor = (lang, path) => (lang === 'ru' ? '/ru' + path : path);
const absUrl = (p) => site.baseUrl.replace(/\/$/, '') + p;
const ctxBase = { site, fieldSvg, fieldAttrs: fieldAttrs(FIELD), url: urlFor };
const model = R.prepare(site, talks, NOW);

function jsonLd(page) {
  const lang = page.lang;
  if (page.kind === 'talk' && page.talk) {
    const t = page.talk;
    const data = {
      '@context': 'https://schema.org', '@type': 'Event',
      name: R.L(t.title, lang),
      startDate: t.start.toISOString(), endDate: t.end.toISOString(),
      eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
      eventStatus: 'https://schema.org/EventScheduled',
      location: { '@type': 'VirtualLocation', url: absUrl(urlFor(lang, R.talkPath(t))) },
      inLanguage: t.language,
      description: R.synopsis(R.L(t.abstract, lang), 400),
      performer: { '@type': 'Person', name: R.L(t.speaker, lang), affiliation: R.L(t.affiliation, lang) || undefined },
      organizer: { '@type': 'Organization', name: 'AFFLUX', url: site.baseUrl },
      url: absUrl(urlFor(lang, R.talkPath(t)))
    };
    if (t.recording) data.recordedIn = { '@type': 'VideoObject', name: R.L(t.title, lang), url: t.recording };
    return data;
  }
  if (page.kind === 'home') {
    return { '@context': 'https://schema.org', '@type': 'Organization', name: 'AFFLUX', alternateName: site.strings[lang].subtitle, url: site.baseUrl, email: site.email };
  }
  return null;
}

function fontFaceInline() {
  const dataUri = (file) => `data:font/woff2;base64,${readFileSync(join(HERE, 'assets/fonts', file)).toString('base64')}`;
  return css.replace(/url\('\/assets\/fonts\/([A-Za-z0-9-]+\.woff2)'\)/g, (_, f) => `url('${dataUri(f)}')`);
}

function head(page, opts) {
  const { lang } = page;
  const preview = opts && opts.preview;
  const path = page.path;
  const canonical = absUrl(urlFor(lang, path));
  const ld = jsonLd(page);
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${preview ? '' : `<meta http-equiv="Content-Security-Policy" content="${CSP_META}">`}
<title>${R.esc(page.title)}</title>
<meta name="description" content="${R.esc(page.description)}">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#070E1A">
<script>${THEME_INIT}</script>
${preview ? '' : `<link rel="canonical" href="${canonical}">
<link rel="alternate" hreflang="en" href="${absUrl(urlFor('en', path))}">
<link rel="alternate" hreflang="ru" href="${absUrl(urlFor('ru', path))}">
<link rel="alternate" hreflang="x-default" href="${absUrl(urlFor('en', path))}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="sitemap" type="application/xml" href="/sitemap.xml">
<link rel="preload" href="/assets/fonts/OldStandardTT-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/GolosText-Variable.woff2" as="font" type="font/woff2" crossorigin>`}
<meta property="og:site_name" content="AFFLUX">
<meta property="og:type" content="${page.kind === 'talk' ? 'article' : 'website'}">
<meta property="og:title" content="${R.esc(page.title)}">
<meta property="og:description" content="${R.esc(page.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${absUrl(site.ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="${lang === 'ru' ? 'ru_RU' : 'en_GB'}">
<meta property="og:locale:alternate" content="${lang === 'ru' ? 'en_GB' : 'ru_RU'}">
<meta name="twitter:card" content="summary_large_image">
${preview ? `<style>\n${fontFaceInline()}\n</style>` : `<link rel="stylesheet" href="/assets/style.css">\n<script src="/assets/client.js" defer></script>\n<script src="/assets/field-live.js" defer></script>`}
${ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/<\//g, '<\\/')}</script>` : ''}`;
}

function document(page) {
  const s = site.strings[page.lang];
  return `<!doctype html>
<html lang="${page.lang}">
<head>
${head(page)}
</head>
<body>
<a class="skip" href="#main">${R.esc(s.skip)}</a>
${page.header}
<main id="main" class="wrap" tabindex="-1">
${page.main}
</main>
${page.footer}
</body>
</html>
`;
}

/* ---------- write dist ---------- */

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'assets/fonts'), { recursive: true });

const routes = [
  { kind: 'home', path: '/' },
  { kind: 'upcoming', path: '/upcoming/' },
  { kind: 'archive', path: '/archive/' },
  { kind: 'about', path: '/about/' },
  { kind: 'subscribe', path: '/subscribe/' },
  ...talks.map((t) => ({ kind: 'talk', slug: t.slug, path: R.talkPath(t) }))
];

const written = [];
const today = NOW.toISOString().slice(0, 10);
for (const lang of ['en', 'ru']) {
  for (const r of routes) {
    const page = R.renderRoute({ ...r, lang }, ctxBase, model);
    const rel = urlFor(lang, r.path);
    mkdirSync(join(OUT, rel), { recursive: true });
    writeFileSync(join(OUT, rel, 'index.html'), document(page));
    written.push({ loc: absUrl(rel), lang, path: r.path, lastmod: r.kind === 'talk' ? talks.find((t) => t.slug === r.slug).date : today });
  }
  const nf = R.renderRoute({ kind: '404', path: '/404/', lang }, ctxBase, model);
  writeFileSync(join(OUT, lang === 'ru' ? 'ru/404.html' : '404.html'), document(nf));
}

// assets
writeFileSync(join(OUT, 'assets/style.css'), css);
writeFileSync(join(OUT, 'assets/client.js'), clientJs);
writeFileSync(join(OUT, 'assets/field-live.js'), fieldLiveJs);
for (const f of readdirSync(join(HERE, 'assets/fonts'))) if (/\.(woff2|txt)$/.test(f)) cpSync(join(HERE, 'assets/fonts', f), join(OUT, 'assets/fonts', f));
for (const f of readdirSync(join(HERE, 'assets'))) if (/\.(png|jpe?g|svg|webp)$/i.test(f)) cpSync(join(HERE, 'assets', f), join(OUT, 'assets', f));
if (existsSync(PHOTOS_DIR)) {
  if (lstatSync(PHOTOS_DIR).isSymbolicLink()) { console.error('content: photos/ is a symbolic link; refused'); process.exit(1); }
  const photos = [];
  for (const f of readdirSync(PHOTOS_DIR)) {
    if (/\.(txt|md)$/i.test(f)) continue;
    try { const p = safePhoto(PHOTOS_DIR, f); if (p) photos.push([p, f]); else { console.error(`content: unexpected file in photos/: ${f}`); process.exit(1); } }
    catch (e) { console.error(e.message); process.exit(1); }
  }
  if (photos.length) { mkdirSync(join(OUT, 'photos'), { recursive: true }); for (const [p, f] of photos) copyFileSync(p, join(OUT, 'photos', f)); }
}
if (existsSync(FILES_DIR)) {
  if (lstatSync(FILES_DIR).isSymbolicLink()) { console.error('content: files/ is a symbolic link; refused'); process.exit(1); }
  const files = [];
  for (const f of readdirSync(FILES_DIR)) {
    if (/\.(txt|md)$/i.test(f)) continue;
    try { const p = safeFile(FILES_DIR, f); if (p) files.push([p, f]); else { console.error(`content: unexpected file in files/: ${f}`); process.exit(1); } }
    catch (e) { console.error(e.message); process.exit(1); }
  }
  if (files.length) { mkdirSync(join(OUT, 'files'), { recursive: true }); for (const [p, f] of files) copyFileSync(p, join(OUT, 'files', f)); }
}
// Every talk's photo, and every locally placed document, must exist among the validated files.
for (const t of talks) {
  if (t.photo && !existsSync(join(OUT, 'photos', t.photo))) { console.error(`${t.slug}: photo ${t.photo} is not in photos/`); process.exit(1); }
  for (const k of ['slides', 'minutes']) if (t[k] && !/^https:/.test(t[k]) && !existsSync(join(OUT, 'files', docName(t[k])))) { console.error(`${t.slug}: ${k} ${t[k]} is not in files/`); process.exit(1); }
}
// What content this build was made from, served publicly so the deploy workflow can compare the live site with the repository.
writeFileSync(join(OUT, 'content-version.txt'), (CONTENT_SHA || 'local') + '\n');
writeFileSync(join(OUT, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#050B15"/><circle cx="32" cy="32" r="4" fill="#41E2C3"/><path d="M4 14c14 4 20 12 28 18M4 32h24M4 50c14-4 20-12 28-18M60 8c-10 8-18 16-26 22M60 56c-10-8-18-16-26-22" fill="none" stroke="#D5DDDA" stroke-width="1.4" stroke-linecap="round"/></svg>`);

// sitemap with hreflang pairs
const byPath = new Map();
for (const w of written) { if (!byPath.has(w.path)) byPath.set(w.path, {}); byPath.get(w.path)[w.lang] = w; }
writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${[...byPath.values()].flatMap((pair) => ['en', 'ru'].map((lang) => `  <url>
    <loc>${pair[lang].loc}</loc>
    <lastmod>${pair[lang].lastmod}</lastmod>
    <xhtml:link rel="alternate" hreflang="en" href="${pair.en.loc}"/>
    <xhtml:link rel="alternate" hreflang="ru" href="${pair.ru.loc}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${pair.en.loc}"/>
  </url>`)).join('\n')}
</urlset>
`);
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /api/\nSitemap: ${absUrl('/sitemap.xml')}\n`);

// Security headers for hosts that read _headers (Netlify, Cloudflare Pages). GitHub Pages ignores this
// file; there the <meta> CSP in every page applies (everything except frame-ancestors).
// Public programme data for the server admin (public information only: no URLs).
writeFileSync(join(OUT, 'programme.json'), JSON.stringify({
  generated: NOW.toISOString(),
  talks: model.all.map((t) => ({ slug: t.slug, number: t.number, date: t.date, time: t.time, timezone: t.timezone, language: t.language,
    title: t.title, speaker: t.speaker, affiliation: t.affiliation || '', abstract: t.abstract || {}, status: t.status, join: !!t.join, recording: !!t.recording, slides: !!t.slides, minutes: !!t.minutes }))
}, null, 2));
writeFileSync(join(OUT, '_headers'), `/*
  Content-Security-Policy: ${CSP_HEADER}
${Object.entries(SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`).join('\n')}
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/files/*
  Cache-Control: public, max-age=3600
  Content-Disposition: inline
`);

/* ---------- optional single-file preview (design review only) ---------- */

if (flag('--preview')) {
  const PREV = join(HERE, 'preview');
  mkdirSync(PREV, { recursive: true });
  const homePage = R.renderRoute({ kind: 'home', path: '/', lang: 'en' }, { ...ctxBase, url: (l, p) => '#' + urlFor(l, p) }, model);
  const previewData = JSON.stringify({ site, talks, fieldSvg, fieldAttrs: fieldAttrs(FIELD) }).replace(/<\//g, '<\\/');
  const preview = `<!doctype html>
<html lang="en" data-preview>
<head>
${head(homePage, { preview: true })}
</head>
<body>
<a class="skip" href="#main" id="skip-link">${R.esc(site.strings.en.skip)}</a>
<div id="app"></div>
<script id="afflux-data" type="application/json">${previewData}</script>
<script>
${renderSrc}
</script>
<script>
${clientJs}
</script>
<script id="field-live-src" type="text/plain">
${fieldLiveJs.replace(/<\//g, '<\\/')}
</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('afflux-data').textContent);
  var R = window.AFFLUX, C = window.AFFLUX_CLIENT;
  var model = R.prepare(data.site, data.talks, new Date());
  var ctx = { site: data.site, fieldSvg: data.fieldSvg, fieldAttrs: data.fieldAttrs, url: function (l, p) { return '#' + (l === 'ru' ? '/ru' + p : p); } };
  var liveSrc = document.getElementById('field-live-src').textContent;
  var lastPath = null;
  function route() {
    var raw = location.hash.replace(/^#/, '') || '/';
    if (raw === 'main') return;
    var r = R.parsePath(raw);
    var page = R.renderRoute(r, ctx, model);
    document.documentElement.lang = page.lang;
    document.title = page.title;
    document.getElementById('skip-link').textContent = data.site.strings[page.lang].skip;
    var app = document.getElementById('app');
    app.innerHTML = page.header + '<main id="main" class="wrap" tabindex="-1">' + page.main + '</main>' + page.footer;
    C.init(app);
    C.headerState();
    try { new Function(liveSrc)(); } catch (e) {}
    if (lastPath !== null && lastPath !== raw) { window.scrollTo(0, 0); var m = document.getElementById('main'); if (m) m.focus({ preventScroll: true }); }
    lastPath = raw;
  }
  window.addEventListener('hashchange', route);
  route();
})();
</script>
</body>
</html>
`;
  writeFileSync(join(PREV, 'afflux-preview.html'), preview);
  console.log(`Preview: preview/afflux-preview.html (${(preview.length / 1024).toFixed(0)} kB)`);
}

/* ---------- report ---------- */

const count = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(d, e.name)) : 1), 0);
console.log(`AFFLUX: ${written.length} pages (${model.upcoming.length} upcoming, ${model.past.length} in the archive) → ${OUT.replace(HERE + '/', '')}/ (${count(OUT)} files)`);
