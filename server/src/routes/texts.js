/* The site's texts: one form, behind Cloudflare Access like the rest of /admin. What the secretary
   may change without touching the code — the About page, the conveners' names and credentials, and
   the short texts of the masthead, footer, programme and Subscribe pages — is written to the content
   repository as data/site-texts.json; the build checks the file and merges it over the defaults in
   data/site.json (src/texts.js). The public site rebuilds itself within minutes. */
import siteJson from '../../../data/site.json';
import { TEXT_GROUPS, LANGS, LIMITS, validateTexts, applyTexts, textsOf } from '../../../src/texts.js';
import { content } from '../github.js';
import { html, redirect } from './auth.js';
import { readForm } from '../security.js';
import * as P from '../pages.js';

const esc = P.esc;
const PATH = 'data/site-texts.json';
export const MAX_TEXTS_BODY = 512 * 1024;   // a long About in two languages is a few tens of kilobytes
const textOf = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
const lines = (v) => textOf(v).split('\n').map((l) => l.trim()).filter(Boolean);
const paragraphs = (v) => textOf(v).split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
const LANG_NAME = { en: 'English', ru: 'Russian' };

const contentError = (e) => {
  if (e && e.code === 'E_CONTENT_CONFIG') return 'The content repository is not configured: CONTENT_REPO (wrangler.toml) and the GITHUB_CONTENT_TOKEN secret are needed.';
  if (e && e.code === 'E_CONTENT_AUTH') return 'GitHub refused the token: it is invalid, expired, or lacks "Contents: read and write" on the content repository.';
  if (e && e.code === 'E_CONTENT_CONFLICT') return 'The texts changed in the repository while you were editing (someone else saved them, or the page was open too long). Reload the page and repeat your change.';
  if (e && e.code && String(e.code).startsWith('E_CONTENT')) return `GitHub answered with an error (${e.status || ''} ${e.detail || ''}). Try again in a minute.`;
  return null;
};

/* ---------- form ---------- */

const ta = (name, value, rows, max) => `<textarea class="ta" id="${name}" name="${name}" rows="${rows}" maxlength="${max}">${esc(value)}</textarea>`;
const input = (name, value, max) => `<input id="${name}" type="text" name="${name}" value="${esc(value)}" maxlength="${max}">`;
const pair = (label, hint, cells) => `<div class="field"><p class="form-label">${esc(label)}</p>${hint ? `<p class="note">${esc(hint)}</p>` : ''}<div class="form-grid2">${LANGS.map((l) => `<div><label for="${cells.id(l)}">${LANG_NAME[l]}</label>${cells.html(l)}</div>`).join('')}</div></div>`;

function form(t, o) {
  const err = o.errors && o.errors.length ? `<div class="form-status" role="alert">${o.errors.map((x) => `<div>${esc(x)}</div>`).join('')}</div>` : '';
  const saved = o.saved ? '<p class="form-status">Saved. The public site updates within about 15 minutes.</p>' : '';
  const groups = TEXT_GROUPS.map((g) => `<h3 class="form-h">${esc(g.title)}</h3>` + g.fields.map((f) => pair(f.label, '', {
    id: (l) => `s_${l}_${f.key}`,
    html: (l) => (f.rows ? ta(`s_${l}_${f.key}`, t.strings[l][f.key], f.rows, f.max) : input(`s_${l}_${f.key}`, t.strings[l][f.key], f.max))
  })).join('')).join('');
  const about = `<h3 class="form-h">About the seminar</h3>` + pair('Text of the About page', 'A blank line starts a new paragraph.', {
    id: (l) => `about_${l}`,
    html: (l) => ta(`about_${l}`, t.about[l].join('\n\n'), 12, LIMITS.paragraph * LIMITS.paragraphs)
  });
  const slots = Math.min(LIMITS.conveners, t.conveners.length + 1);
  const conveners = `<h3 class="form-h">Conveners <span class="note">(an empty name removes the entry; the last slot adds one)</span></h3>` + Array.from({ length: slots }, (_, i) => {
    const c = t.conveners[i] || { name: { en: '', ru: '' }, fullName: { en: '', ru: '' }, credentials: { en: [], ru: [] } };
    return `<div class="form-convener">
${pair(`Convener ${i + 1}: short name`, 'As in the masthead and the footer (initials in Russian).', { id: (l) => `c${i}_name_${l}`, html: (l) => input(`c${i}_name_${l}`, c.name[l], LIMITS.name) })}
${pair(`Convener ${i + 1}: full name`, 'As on the About page.', { id: (l) => `c${i}_full_${l}`, html: (l) => input(`c${i}_full_${l}`, c.fullName[l], LIMITS.name) })}
${pair(`Convener ${i + 1}: credentials`, 'One line each: degrees, positions, memberships.', { id: (l) => `c${i}_cred_${l}`, html: (l) => ta(`c${i}_cred_${l}`, c.credentials[l].join('\n'), 6, LIMITS.credential * LIMITS.credentials) })}
</div>`;
  }).join('');
  return `<section class="sec"><h2 class="sec-label">Site texts</h2><div class="sec-body">
${saved}${err}
<form class="form form-wide" method="post" action="/admin/texts/save">
<input type="hidden" name="sha" value="${esc(o.sha || '')}">
<p class="note">These are the texts of the site itself; the talks are edited in the programme. Leave a field empty to use the built-in default. Titles, names and figures are set in the site's own typography automatically.</p>
${groups}
${about}
${conveners}
<p class="actions"><button class="btn" type="submit">Save texts</button><a class="more" href="/admin/">Overview</a></p>
</form></div></section>`;
}

/* The form, as a texts object in the file's shape. */
function textsFromForm(f) {
  const g = (k) => f.get(k);
  const strings = {}, about = {};
  for (const l of LANGS) {
    strings[l] = {};
    for (const fld of TEXT_GROUPS.flatMap((x) => x.fields)) strings[l][fld.key] = textOf(g(`s_${l}_${fld.key}`));
    about[l] = paragraphs(g(`about_${l}`));
  }
  const conveners = [];
  for (let i = 0; i < LIMITS.conveners; i++) {
    if (!f.has(`c${i}_name_en`) && !f.has(`c${i}_name_ru`)) continue;
    const c = { name: {}, fullName: {}, credentials: {} };
    for (const l of LANGS) {
      c.name[l] = textOf(g(`c${i}_name_${l}`)).slice(0, LIMITS.name);
      c.fullName[l] = textOf(g(`c${i}_full_${l}`)).slice(0, LIMITS.name);
      c.credentials[l] = lines(g(`c${i}_cred_${l}`));
    }
    if (LANGS.some((l) => c.name[l])) conveners.push(c);
  }
  return { strings, about, conveners };
}

/* ---------- routes ---------- */

export async function textsAdmin(req, env, sub, who) {
  const url = new URL(req.url);
  const isPost = req.method === 'POST';
  const closed = env.REGISTRATION === 'closed';
  const page = (main, status) => html(P.adminPage({ title: 'Texts', main, who, closed }), status);

  if (sub === '/texts') {
    if (isPost) return new Response('Method not allowed', { status: 405 });
    let file = null, note = '';
    try { file = await content.getText(env, PATH); } catch (e) { note = contentError(e) || 'Could not read the content repository.'; }
    let overrides = null;
    if (file) {
      try { overrides = JSON.parse(file.text); } catch (e) { note = `The file ${PATH} in the repository is not valid JSON; saving this form replaces it.`; }
      if (overrides && validateTexts(overrides).length) { note = `The file ${PATH} in the repository has problems (${validateTexts(overrides)[0]}); saving this form replaces it.`; overrides = null; }
    }
    const t = textsOf(applyTexts(siteJson, overrides));
    return page(form(t, { sha: file ? file.sha : '', errors: note ? [note] : [], saved: url.searchParams.get('s') === 'saved' }));
  }

  if (sub === '/texts/save') {
    if (!isPost) return redirect('/admin/texts');
    const f = await readForm(req, MAX_TEXTS_BODY);
    if (!f) return new Response('Bad request', { status: 400 });
    const t = textsFromForm(f);
    const errors = validateTexts(t);
    if (!t.conveners.length) errors.push('At least one convener is needed.');
    if (errors.length) return page(form(t, { sha: String(f.get('sha') || ''), errors }), 422);
    const sha = String(f.get('sha') || '');
    try {
      await content.put(env, PATH, JSON.stringify(t, null, 2) + '\n', 'Site texts edited in the admin', sha || undefined);
    } catch (e) {
      return page(form(t, { sha, errors: [contentError(e) || 'Could not save to the content repository.'] }), e.code === 'E_CONTENT_CONFLICT' ? 409 : 502);
    }
    return redirect('/admin/texts?s=saved');
  }
  return new Response('Not found', { status: 404 });
}
