/* Server-rendered pages, built with the same templates and strings as the static site. */
import '../../src/render.js';
import siteJson from '../../data/site.json';
import { THEME_INIT, cspPolicy } from '../../src/shared.js';
import { FIELD, streamlineSvg, fieldAttrs } from '../../src/field.js';

const FIELD_SVG = streamlineSvg(FIELD);
// The caption is site-authored markup (data/site.json), not visitor input: it carries the formula's italics.
const figure = (lang, mode) => `<figure class="field" aria-hidden="true"${fieldAttrs(FIELD)} data-mode="${mode}">${FIELD_SVG}<figcaption>${mode === 'source' ? (t(lang).fieldCaptionSourceHtml || esc(t(lang).fieldCaptionSource)) : (t(lang).fieldCaptionHtml || esc(t(lang).fieldCaption))}</figcaption></figure>`;

const R = globalThis.AFFLUX;
export const site = R.typoSite(siteJson);
export const esc = R.esc;
export const urlFor = (lang, path) => (lang === 'ru' ? '/ru' + path : path);
export const t = (lang) => site.strings[lang];
export const ta = (lang) => site.strings[lang].account;
export const fill = R.fill;
export const L = R.L;

export function ctxFor(lang) { return { site, lang, url: urlFor }; }

export function shell({ lang, kind, path, title, description, main }) {
  const ctx = ctxFor(lang);
  const s = t(lang);
  const page = { kind, path };
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${cspPolicy()}">
<meta name="robots" content="noindex">
<title>${esc(title)}, AFFLUX</title>
<meta name="description" content="${esc(description || '')}">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#070E1A">
<script>${THEME_INIT}</script>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/OldStandardTT-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/GolosText-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/style.css">
<script src="/assets/client.js" defer></script>
<script src="/assets/field-live.js" defer></script>
</head>
<body>
<a class="skip" href="#main">${esc(s.skip)}</a>
${R.header(ctx, page)}
<main id="main" class="wrap" tabindex="-1">
${main}
</main>
${R.footer(ctx)}
</body>
</html>
`;
}

const head = (title, lead) => `<section class="page-head">
  <h1 class="page-title">${esc(title)}</h1>
  ${lead ? `<p class="lede">${esc(lead)}</p>` : ''}
</section>`;

const status = (msg) => (msg ? `<p class="form-status" role="status">${esc(msg)}</p>` : '');
const errLine = (msg) => (msg ? `<p class="err" role="alert">${esc(msg)}</p>` : '');
const hidden = (lang) => `<input type="hidden" name="lang" value="${lang}"><div class="hp" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>`;

function listsFields(lang, v) {
  const a = ta(lang);
  const order = lang === 'ru' ? ['ru', 'en'] : ['en', 'ru'];
  return order.map((l) => `<div class="check">
  <input type="checkbox" id="list_${l}" name="list_${l}" value="1"${v && v['pref_' + l] ? ' checked' : ''}>
  <label for="list_${l}">${esc(l === 'ru' ? a.listRu : a.listEn)}</label>
</div>`).join('\n') + `<p class="note">${esc(a.listsHint)}</p>`;
}

export function registerPage(lang, opts = {}) {
  const a = ta(lang); const v = opts.values || {};
  const main = `${head(a.registerTitle, a.registerLead)}
<section class="sec">
  <div class="sec-label"></div>
  <div class="sec-body">
    ${status(opts.status)}
    <div class="form-grid">
    <form class="form" method="post" action="/api/register" novalidate data-gather>
      ${hidden(lang)}
      <div class="field"><label for="name">${esc(a.nameLabel)}</label><input id="name" type="text" name="name" required maxlength="120" autocomplete="name" value="${esc(v.name || '')}"${opts.errors && opts.errors.name ? ' aria-invalid="true"' : ''}>${errLine(opts.errors && opts.errors.name)}</div>
      <div class="field"><label for="email">${esc(a.emailLabel)}</label><input id="email" type="email" name="email" required maxlength="254" autocomplete="email" inputmode="email" value="${esc(v.email || '')}"${opts.errors && opts.errors.email ? ' aria-invalid="true"' : ''}>${errLine(opts.errors && opts.errors.email)}</div>
      <div class="field"><label for="affiliation">${esc(a.affiliationLabel)}</label><input id="affiliation" type="text" name="affiliation" maxlength="200" autocomplete="organization" value="${esc(v.affiliation || '')}"></div>
      <fieldset class="field">${listsFields(lang, v)}</fieldset>
      ${errLine(opts.errors && opts.errors.form)}
      <p class="actions"><button class="btn" type="submit">${esc(a.registerButton)}</button><span class="more">${esc(a.haveAccount)} <a href="${urlFor(lang, '/signin/')}">${esc(a.signinLink)}</a></span></p>
      <p class="note">${esc(a.privacyNote)}</p>
    </form>
    ${figure(lang, 'sink')}
    </div>
  </div>
</section>`;
  return shell({ lang, kind: 'register', path: '/register/', title: a.registerTitle, description: a.registerLead, main });
}

export function signinPage(lang, opts = {}) {
  const a = ta(lang); const v = opts.values || {};
  const main = `${head(a.signinTitle, a.signinLead)}
<section class="sec">
  <div class="sec-label"></div>
  <div class="sec-body">
    ${status(opts.status)}
    <div class="form-grid">
    <form class="form" method="post" action="/api/signin" novalidate data-gather>
      ${hidden(lang)}
      <div class="field"><label for="email">${esc(a.emailLabel)}</label><input id="email" type="email" name="email" required maxlength="254" autocomplete="email" inputmode="email" value="${esc(v.email || '')}"${opts.errors && opts.errors.email ? ' aria-invalid="true"' : ''}>${errLine(opts.errors && opts.errors.email)}</div>
      ${errLine(opts.errors && opts.errors.form)}
      <p class="actions"><button class="btn" type="submit">${esc(a.signinButton)}</button><span class="more">${esc(a.noAccount)} <a href="${urlFor(lang, '/register/')}">${esc(a.registerLink)}</a></span></p>
      <p class="note">${esc(a.sessionNote)}</p>
    </form>
    ${figure(lang, 'sink')}
    </div>
  </div>
</section>`;
  return shell({ lang, kind: 'signin', path: '/signin/', title: a.signinTitle, description: a.signinLead, main });
}

export function checkEmailPage(lang, email, hours, from, minutes) {
  const a = ta(lang);
  const main = `${head(a.checkTitle)}
<section class="sec"><div class="sec-label"></div><div class="sec-body"><div class="form-grid"><div class="prose">
<p class="rise">${esc(minutes ? fill(a.checkTextMinutes, { email, minutes }) : fill(a.checkText, { email, hours }))}</p>
<p class="rise rise-2">${esc(fill(a.checkFrom, { from: from || '' }))}</p>
<p class="actions rise rise-2"><a class="more" href="${urlFor(lang, '/signin/')}">${esc(a.signinLink)}</a></p></div>
${figure(lang, 'source')}
</div></div></section>`;
  return shell({ lang, kind: 'register', path: '/register/', title: a.checkTitle, main });
}

export function verifyPage(lang, o = {}) {
  const a = ta(lang);
  let main;
  if (o.failed) {
    main = `${head(a.verifyFailedTitle, o.strict ? a.verifyStrictText : a.verifyFailedText)}
<section class="sec"><div class="sec-label"></div><div class="sec-body"><p class="actions"><a class="btn" href="${urlFor(lang, '/signin/')}">${esc(a.signinLink)}</a></p></div></section>`;
  } else if (o.foreign) {
    main = `${head(a.verifyForeignTitle, fill(a.verifyForeignText, { masked: o.masked }))}
<section class="sec"><div class="sec-label"></div><div class="sec-body">
  <form class="form" method="post" action="/api/signout">${hidden(lang)}<p class="actions"><button class="btn btn-quiet" type="submit">${esc(a.signoutButton)}</button><a class="more" href="${urlFor(lang, '/account/')}">${esc(a.accountTitle)}</a></p></form>
</div></section>`;
  } else {
    main = `${head(a.verifyTitle, fill(a.verifyText, { masked: o.masked }))}
<section class="sec"><div class="sec-label"></div><div class="sec-body">
  ${o.stale ? `<p class="form-status">${esc(a.verifyStale)}</p>` : ''}
  ${o.sameBrowser ? '' : `<p class="form-status">${esc(a.verifyOtherBrowser)}</p>`}
  <form class="form" method="post" action="/api/verify">${hidden(lang)}<input type="hidden" name="c" value="${esc(o.form || '')}">
  <p class="actions"><button class="btn" type="submit">${esc(a.verifyButton)}</button></p></form>
</div></section>`;
  }
  return shell({ lang, kind: 'signin', path: '/signin/', title: a.verifyTitle, main });
}

export function completePage(lang, opts = {}) {
  const a = ta(lang); const v = opts.values || {};
  const main = `${head(a.completeTitle, a.completeLead)}
<section class="sec"><div class="sec-label"></div><div class="sec-body">
  <form class="form" method="post" action="/api/profile" novalidate>
    ${hidden(lang)}
    <div class="field"><label for="name">${esc(a.nameLabel)}</label><input id="name" type="text" name="name" required maxlength="120" autocomplete="name" value="${esc(v.name || '')}">${errLine(opts.errors && opts.errors.name)}</div>
    <div class="field"><label for="affiliation">${esc(a.affiliationLabel)}</label><input id="affiliation" type="text" name="affiliation" maxlength="200" value="${esc(v.affiliation || '')}"></div>
    <fieldset class="field">${listsFields(lang, v)}</fieldset>
    <p class="actions"><button class="btn" type="submit">${esc(a.saveButton)}</button></p>
  </form>
</div></section>`;
  return shell({ lang, kind: 'account', path: '/account/', title: a.completeTitle, main });
}

export function accountPage(lang, user, opts = {}) {
  const a = ta(lang);
  const main = `${head(a.accountTitle, a.accountLead)}
<section class="sec"><div class="sec-label"></div><div class="sec-body">
  ${status(opts.status)}
  <form class="form" method="post" action="/api/account" novalidate>
    ${hidden(lang)}
    <div class="field"><label for="name">${esc(a.nameLabel)}</label><input id="name" type="text" name="name" required maxlength="120" value="${esc(user.name)}">${errLine(opts.errors && opts.errors.name)}</div>
    <div class="field"><label for="affiliation">${esc(a.affiliationLabel)}</label><input id="affiliation" type="text" name="affiliation" maxlength="200" value="${esc(user.affiliation || '')}"></div>
    <fieldset class="field">${listsFields(lang, user)}</fieldset>
    <p class="actions"><button class="btn" type="submit">${esc(a.saveButton)}</button></p>
    <p class="note">${esc(a.privacyNoteAccount)}</p>
  </form>
  <p class="sec-more">${esc(a.feedbackNote)} <a href="${urlFor(lang, '/account/feedback')}">${esc(a.feedbackLink)}</a></p>
  <div class="danger">
    <form class="form" method="post" action="/api/signout">${hidden(lang)}<p class="actions"><button class="btn btn-quiet" type="submit">${esc(a.signoutButton)}</button><button class="btn btn-quiet" type="submit" name="all" value="1">${esc(a.signoutAll)}</button></p></form>
    <form class="form" method="post" action="/api/delete" data-confirm="${esc(a.deleteConfirm)}">${hidden(lang)}<p class="actions"><button class="btn btn-quiet" type="submit">${esc(a.deleteButton)}</button></p></form>
  </div>
</div></section>`;
  return shell({ lang, kind: 'account', path: '/account/', title: a.accountTitle, main });
}

/* Comments and suggestions: a signed-in participant writes to the conveners; the message is mailed, nothing is stored. */
export function feedbackPage(lang, opts = {}) {
  const a = ta(lang); const v = opts.values || {};
  const main = `${head(a.feedbackTitle, a.feedbackLead)}
<section class="sec"><div class="sec-label"></div><div class="sec-body">
  ${status(opts.status)}
  ${opts.sent ? `<p class="actions"><a class="more" href="${urlFor(lang, '/account/')}">${esc(a.accountTitle)}</a></p>` : `<form class="form" method="post" action="/api/feedback" novalidate>
    ${hidden(lang)}
    <div class="field"><label for="subject">${esc(a.feedbackSubjectLabel)}</label><input id="subject" type="text" name="subject" maxlength="150" value="${esc(v.subject || '')}"></div>
    <div class="field"><label for="message">${esc(a.feedbackLabel)}</label><textarea id="message" class="ta" name="message" rows="8" required maxlength="6000"${opts.errors && opts.errors.message ? ' aria-invalid="true"' : ''}>${esc(v.message || '')}</textarea>${errLine(opts.errors && opts.errors.message)}</div>
    ${errLine(opts.errors && opts.errors.form)}
    <p class="actions"><button class="btn" type="submit">${esc(a.feedbackButton)}</button><a class="more" href="${urlFor(lang, '/account/')}">${esc(a.accountTitle)}</a></p>
  </form>`}
</div></section>`;
  return shell({ lang, kind: 'account', path: '/account/', title: a.feedbackTitle, description: a.feedbackLead, main });
}

export function messagePage(lang, kind, title, text, cta) {
  const main = `${head(title, text)}${cta ? `<section class="sec"><div class="sec-label"></div><div class="sec-body"><p class="actions"><a class="btn" href="${esc(cta.href)}">${esc(cta.label)}</a></p></div></section>` : ''}`;
  return shell({ lang, kind, path: '/', title, main });
}

export function gatePage(lang, resource) {
  const a = ta(lang);
  const main = `${head(a.gateTitle, a.gateText)}
<section class="sec"><div class="sec-label"></div><div class="sec-body">
  <p class="actions"><a class="btn" href="${urlFor(lang, '/register/')}">${esc(a.registerButton)}</a><a class="more" href="${urlFor(lang, '/signin/')}">${esc(a.signinLink)}</a></p>
</div></section>`;
  return shell({ lang, kind: 'register', path: '/register/', title: a.gateTitle, main });
}

export function unsubscribePage(lang, token, done, invalid) {
  const a = ta(lang);
  let body;
  if (invalid) body = `${head(a.unsubTitle, a.unsubInvalid)}`;
  else if (done) body = `${head(a.unsubTitle, a.unsubDone)}`;
  else body = `${head(a.unsubTitle, a.unsubText)}
<section class="sec"><div class="sec-label"></div><div class="sec-body"><form class="form" method="post" action="/api/unsubscribe">${hidden(lang)}<input type="hidden" name="t" value="${esc(token)}"><p class="actions"><button class="btn" type="submit">${esc(a.unsubButton)}</button></p></form></div></section>`;
  return shell({ lang, kind: 'account', path: '/account/', title: a.unsubTitle, main: body });
}

/* Admin pages: plain, behind Cloudflare Access. English only. */
export function adminPage({ title, main, who, closed }) {
  const nav = closed
    ? `<a href="/admin/">Overview</a>, <a href="/admin/talks">Programme</a>, <a href="/admin/texts">Texts</a>.`
    : `<a href="/admin/">Overview</a>, <a href="/admin/talks">Programme</a>, <a href="/admin/texts">Texts</a>, <a href="/admin/announce">Announcement</a>, <a href="/admin/links">Protected links</a>.`;
  return shell({ lang: 'en', kind: 'account', path: '/admin/', title: `Admin: ${title}`, main: `<section class="page-head"><h1 class="page-title">${esc(title)}</h1><p class="lede">Signed in as ${esc(who)}. ${nav}</p></section>${main}` });
}
