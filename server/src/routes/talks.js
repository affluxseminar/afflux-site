/* The programme editor: one form per talk, behind Cloudflare Access like the rest of /admin.
   Public fields go to the content repository (data/talks/<slug>.json, photos/, files/) through
   the GitHub Contents API; the Zoom and recording URLs go to the encrypted links store and never
   to GitHub. The site rebuilds itself from the repository within a few minutes. */
import { content } from '../github.js';
import { links } from '../db.js';
import { html, redirect } from './auth.js';
import { clean, allowedLinkHost, readForm, MAX_UPLOAD_BODY } from '../security.js';
import * as P from '../pages.js';

const esc = P.esc;
const SLUG = /^[A-Za-z0-9._-]{1,120}$/;
const PHOTO_EXT = /\.(jpe?g|png|webp)$/i;
const DOC_EXT = /\.(pdf|pptx?)$/i;
const DOC_NAME = /^[A-Za-z0-9._-]+\.(pdf|pptx?)$/i;
const URL_RE = /^https:\/\/[^\s"'<>]+$/;
const PHOTO_MAX = 8 * 1024 * 1024, DOC_MAX = 20 * 1024 * 1024;
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const translit = (s) => String(s).toLowerCase().replace(/[а-яё]/g, (c) => TRANSLIT[c] || '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const talkPath = (slug) => `data/talks/${slug}.json`;
const textOf = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
const nameField = (en, ru) => (en && ru ? { en, ru } : (en || ru || ''));
const bilingual = (en, ru) => { const o = {}; if (en) o.en = en; if (ru) o.ru = ru; return o; };
const L = (v, lang) => (v && typeof v === 'object' ? (v[lang] || v.en || v.ru || '') : (v || ''));

/* Magic numbers: the extension alone is the uploader's claim. */
function looksLike(bytes, kind) {
  const b = bytes;
  if (kind === 'jpg') return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  if (kind === 'png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
  if (kind === 'webp') return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  if (kind === 'pdf') return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
  if (kind === 'zip') return b[0] === 0x50 && b[1] === 0x4B;
  return false;
}
async function fileOf(form, name, extRe, max, label, errors) {
  const f = form.get(name);
  if (!f || typeof f === 'string' || !f.size) return null;
  const m = String(f.name || '').match(extRe);
  if (!m) { errors.push(`${label}: unsupported file type (${String(f.name || '').slice(-12)})`); return null; }
  if (f.size > max) { errors.push(`${label}: larger than ${Math.round(max / 1048576)} MB`); return null; }
  const bytes = new Uint8Array(await f.arrayBuffer());
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  const kind = ext === 'jpg' ? 'jpg' : ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : ext === 'pdf' ? 'pdf' : 'zip';
  if (!looksLike(bytes, kind)) { errors.push(`${label}: the file does not look like a ${ext.toUpperCase()}`); return null; }
  return { bytes, ext };
}

async function programme(env) {
  try {
    const r = await fetch(`${env.SITE_BASE}/programme.json`, { cf: { cacheTtl: 30 } });
    if (!r.ok) return [];
    return (await r.json()).talks || [];
  } catch (e) { return []; }
}

const contentError = (e) => {
  if (e && e.code === 'E_CONTENT_CONFIG') return 'The content repository is not configured: CONTENT_REPO (wrangler.toml) and the GITHUB_CONTENT_TOKEN secret are needed.';
  if (e && e.code === 'E_CONTENT_AUTH') return 'GitHub refused the token: it is invalid, expired, or lacks "Contents: read and write" on the content repository. Create a new fine-grained token and set GITHUB_CONTENT_TOKEN.';
  if (e && e.code === 'E_CONTENT_CONFLICT') return 'The talk changed in the repository while you were editing (someone else saved it, or the page was open too long). Open it again and repeat your change.';
  if (e && e.code && String(e.code).startsWith('E_CONTENT')) return `GitHub answered with an error (${e.status || ''} ${e.detail || ''}). Try again in a minute.`;
  return null;
};

/* ---------- form ---------- */

function form(v, o) {
  const err = o.errors && o.errors.length ? `<div class="form-status" role="alert">${o.errors.map((x) => `<div>${esc(x)}</div>`).join('')}</div>` : '';
  const fld = (id, label, input, hint) => `<div class="field"><label for="${id}">${esc(label)}</label>${input}${hint ? `<p class="note">${hint}</p>` : ''}</div>`;
  const txt = (id, val, attrs = '') => `<input id="${id}" type="text" name="${id}" value="${esc(val || '')}"${attrs}>`;
  const ta = (id, val, rows = 6) => `<textarea id="${id}" class="ta" name="${id}" rows="${rows}">${esc(val || '')}</textarea>`;
  return `<section class="sec"><h2 class="sec-label">${o.existing ? 'Edit talk' : 'New talk'}</h2><div class="sec-body">
${err}
<form class="form form-wide" method="post" action="/admin/talks/save" enctype="multipart/form-data" novalidate>
<input type="hidden" name="existing" value="${o.existing ? '1' : ''}"><input type="hidden" name="sha" value="${esc(o.sha || '')}">
<div class="form-grid2">
${fld('date', 'Date', `<input id="date" type="date" name="date" value="${esc(v.date || '')}" required>`)}
${fld('time', 'Time, Moscow', `<input id="time" type="time" name="time" value="${esc(v.time || '17:00')}" required>`)}
${fld('speaker', 'Speaker', txt('speaker', v.speaker, ' required autocomplete="off"'), 'As it should read on the English page.')}
${fld('speaker_ru', 'Speaker in Russian (optional)', txt('speaker_ru', v.speaker_ru))}
${fld('affiliation', 'Affiliation', txt('affiliation', v.affiliation))}
${fld('affiliation_ru', 'Affiliation in Russian (optional)', txt('affiliation_ru', v.affiliation_ru))}
${fld('language', 'Talk language', `<select id="language" name="language"><option value="en"${v.language !== 'ru' ? ' selected' : ''}>English</option><option value="ru"${v.language === 'ru' ? ' selected' : ''}>Russian</option></select>`, 'Decides which list the announcement goes to.')}
${fld('number', 'Seminar number', `<input id="number" type="number" name="number" min="1" step="1" value="${esc(v.number || '')}">`, 'Leave empty for the next number.')}
${fld('slug', 'Page address (slug)', txt('slug', v.slug, o.existing ? ' readonly' : ' placeholder="made from the date and the surname if left empty"'), o.existing ? 'Cannot change after publishing.' : 'Letters, digits, dots, hyphens. Example: 2026-10-21-ivanova.')}
${fld('photo', 'Photo', `<input id="photo" type="file" name="photo" accept=".jpg,.jpeg,.png,.webp">`, `${v.photo ? `Current: ${esc(v.photo)}. ` : ''}Portrait, at least 480×600 px, up to 8 MB; shown in black and white.`)}
</div>
${fld('title_en', 'Title (EN)', txt('title_en', v.title_en))}
${fld('title_ru', 'Title (RU)', txt('title_ru', v.title_ru), 'At least one title is required; a missing language falls back to the other.')}
<div class="form-grid2">
${fld('abstract_en', 'Abstract (EN)', ta('abstract_en', v.abstract_en, 8), 'Paragraphs separated by an empty line.')}
${fld('abstract_ru', 'Abstract (RU)', ta('abstract_ru', v.abstract_ru, 8))}
${fld('bio_en', 'About the speaker (EN)', ta('bio_en', v.bio_en, 5))}
${fld('bio_ru', 'About the speaker (RU)', ta('bio_ru', v.bio_ru, 5))}
</div>
<h3 class="form-h">Protected links <span class="note">— stored encrypted, never published</span></h3>
<div class="form-grid2">
${fld('zoom', `Zoom URL${o.hasZoom ? ' (one is stored)' : ''}`, txt('zoom', '', ' placeholder="https://…zoom.us/j/…" autocomplete="off"'), `${o.hasZoom ? 'Leave empty to keep the stored link; the' : 'The'} Join button shows while a link is stored.${o.hasZoom ? ' <label class="inline"><input type="checkbox" name="clear_zoom" value="1"> Remove the stored Zoom link</label>' : ''}`)}
${fld('recording', `Recording URL${o.hasRecording ? ' (one is stored)' : ''}`, txt('recording', '', ' placeholder="https://www.youtube.com/watch?v=…" autocomplete="off"'), `Schedule the YouTube stream beforehand (unlisted) and paste its URL here: it becomes the recording when the stream ends.${o.hasRecording ? ' <label class="inline"><input type="checkbox" name="clear_recording" value="1"> Remove the stored recording link</label>' : ''}`)}
</div>
<h3 class="form-h">Documents <span class="note">— public, shown in the archive</span></h3>
<div class="form-grid2">
${fld('slides_file', 'Slides: upload', `<input id="slides_file" type="file" name="slides_file" accept=".pdf,.ppt,.pptx">`, `${v.slides ? `Current: ${esc(v.slides)}. ` : ''}PDF or PPTX up to 20 MB.`)}
${fld('slides_url', 'Slides: or a link', txt('slides_url', URL_RE.test(v.slides || '') ? v.slides : '', ' placeholder="https://…"'))}
${fld('minutes_file', 'Minutes: upload', `<input id="minutes_file" type="file" name="minutes_file" accept=".pdf,.ppt,.pptx">`, `${v.minutes ? `Current: ${esc(v.minutes)}. ` : ''}The minutes of the discussion, PDF.`)}
${fld('minutes_url', 'Minutes: or a link', txt('minutes_url', URL_RE.test(v.minutes || '') ? v.minutes : '', ' placeholder="https://…"'))}
</div>
${v.slides || v.minutes ? `<p class="note"><label class="inline"><input type="checkbox" name="clear_slides" value="1"> Remove slides</label> &nbsp; <label class="inline"><input type="checkbox" name="clear_minutes" value="1"> Remove minutes</label></p>` : ''}
<p class="actions"><button class="btn" type="submit">${o.existing ? 'Save changes' : 'Publish'}</button><a class="more" href="/admin/talks">Back to the programme</a></p>
<p class="note">Publishing writes the talk to the content repository; the site rebuilds itself and shows the change within about an hour. Protected links take effect immediately.</p>
</form>
${o.existing ? `<form class="form" method="post" action="/admin/talks/delete" data-confirm="Delete this talk from the programme? Its photo and documents stay in the repository."><input type="hidden" name="slug" value="${esc(v.slug)}"><p class="actions"><button class="btn btn-quiet" type="submit">Delete talk</button></p></form>` : ''}
</div></section>`;
}

function valuesFrom(t) {
  const v = { slug: t.slug || '', number: t.number || '', date: t.date || '', time: t.time || '17:00', language: t.language || 'en', photo: t.photo || '', slides: t.slides || '', minutes: t.minutes || '' };
  const sp = t.speaker || '', af = t.affiliation || '';
  v.speaker = typeof sp === 'object' ? (sp.en || '') : sp; v.speaker_ru = typeof sp === 'object' ? (sp.ru || '') : '';
  v.affiliation = typeof af === 'object' ? (af.en || '') : af; v.affiliation_ru = typeof af === 'object' ? (af.ru || '') : '';
  for (const k of ['title', 'abstract', 'bio']) { v[`${k}_en`] = (t[k] && t[k].en) || ''; v[`${k}_ru`] = (t[k] && t[k].ru) || ''; }
  return v;
}
function valuesFromForm(f) {
  const g = (k) => textOf(f.get(k));
  return { slug: g('slug'), number: g('number'), date: g('date'), time: g('time'), language: g('language') === 'ru' ? 'ru' : 'en',
    speaker: clean(g('speaker'), 200), speaker_ru: clean(g('speaker_ru'), 200), affiliation: clean(g('affiliation'), 300), affiliation_ru: clean(g('affiliation_ru'), 300),
    title_en: clean(g('title_en'), 500), title_ru: clean(g('title_ru'), 500), abstract_en: g('abstract_en').slice(0, 20000), abstract_ru: g('abstract_ru').slice(0, 20000),
    bio_en: g('bio_en').slice(0, 10000), bio_ru: g('bio_ru').slice(0, 10000), slides_url: clean(g('slides_url'), 2048), minutes_url: clean(g('minutes_url'), 2048) };
}

/* ---------- routes ---------- */

export async function talksAdmin(req, env, sub, who) {
  const url = new URL(req.url);
  const isPost = req.method === 'POST';
  const page = (title, main) => html(P.adminPage({ title, main, who }));

  if (sub === '/talks') {
    if (isPost) return new Response('Method not allowed', { status: 405 });
    const built = await programme(env);
    let files = [], note = '';
    try { files = await content.list(env, 'data/talks'); } catch (e) { note = contentError(e) || 'Could not read the content repository.'; }
    const stored = new Map((await links.all(env)).map((l) => [l.slug, l]));
    const bySlug = new Map(built.map((t) => [t.slug, t]));
    const slugs = new Set([...files.map((f) => f.name.replace(/\.json$/, '')), ...built.map((t) => t.slug)]);
    const rows = [...slugs].map((slug) => ({ slug, t: bySlug.get(slug), inRepo: files.some((f) => f.name === `${slug}.json`) }))
      .sort((a, b) => ((b.t && b.t.date) || b.slug).localeCompare((a.t && a.t.date) || a.slug));
    const st = url.searchParams.get('s');
    const main = `<section class="sec"><h2 class="sec-label">Programme</h2><div class="sec-body">
${st === 'saved' ? '<p class="form-status">Saved. The public pages update within about an hour; protected links are live now.</p>' : st === 'deleted' ? '<p class="form-status">Deleted.</p>' : ''}
${note ? `<p class="form-status">${esc(note)}</p>` : ''}
<p class="actions"><a class="btn" href="/admin/talks/new">New talk</a></p>
${rows.length ? `<ol class="ledger">${rows.map(({ slug, t, inRepo }) => {
      const l = stored.get(slug) || {};
      return `<li class="row"><time class="row-date">${esc(t ? t.date : '—')}</time><span class="row-who"><span>${esc(t ? L(t.speaker, 'en') : '')}</span><span class="row-aff">${esc(t ? (t.status === 'past' ? 'archive' : t.status) : 'publishing…')}${!inRepo ? ' · not in the repository' : ''}</span></span><a class="row-title" href="/admin/talks/edit?slug=${esc(slug)}">${esc(t ? (L(t.title, 'en') || L(t.title, 'ru')) : slug)}</a><span class="row-lang">${esc(t ? t.language.toUpperCase() : '')}</span><span class="row-links">${l.has_zoom ? '<span>Zoom ✓</span>' : ''}${l.has_recording ? '<span>Rec ✓</span>' : ''}<a href="/admin/announce?slug=${esc(slug)}">Announce</a></span></li>`;
    }).join('')}</ol>` : '<p class="note">No talks yet.</p>'}
</div></section>`;
    return page('Programme', main);
  }

  if (sub === '/talks/new') {
    if (isPost) return new Response('Method not allowed', { status: 405 });
    return page('New talk', form({ time: '17:00', language: 'en' }, { existing: false }));
  }

  if (sub === '/talks/edit') {
    if (isPost) return new Response('Method not allowed', { status: 405 });
    const slug = url.searchParams.get('slug') || '';
    if (!SLUG.test(slug)) return new Response('Not found', { status: 404 });
    let file;
    try { file = await content.getText(env, talkPath(slug)); } catch (e) { return page('Edit talk', `<section class="sec"><div class="sec-label"></div><div class="sec-body"><p class="form-status">${esc(contentError(e) || 'Could not read the talk.')}</p></div></section>`); }
    if (!file) return new Response('Not found', { status: 404 });
    let t; try { t = JSON.parse(file.text); } catch (e) { return page('Edit talk', `<section class="sec"><div class="sec-label"></div><div class="sec-body"><p class="form-status">The file ${esc(talkPath(slug))} is not valid JSON; fix it in the repository.</p></div></section>`); }
    const l = await links.get(env, slug);
    return page('Edit talk', form(valuesFrom({ ...t, slug }), { existing: true, sha: file.sha, hasZoom: !!(l && l.zoom), hasRecording: !!(l && l.recording) }));
  }

  if (sub === '/talks/save') {
    if (!isPost) return new Response('Method not allowed', { status: 405 });
    const f = await readForm(req, MAX_UPLOAD_BODY); if (!f) return new Response('Bad request', { status: 400 });
    const existing = f.get('existing') === '1';
    const v = valuesFromForm(f);
    const errors = [];
    if (!v.slug) v.slug = v.date && (v.speaker || v.speaker_ru) ? `${v.date}-${translit((v.speaker || v.speaker_ru).split(/\s+/).filter(Boolean).pop() || '')}` : '';
    if (!SLUG.test(v.slug)) errors.push('Page address (slug): letters, digits, dots and hyphens only.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) errors.push('Date is required (YYYY-MM-DD).');
    if (!/^\d{2}:\d{2}$/.test(v.time)) errors.push('Time is required (HH:MM).');
    if (!v.speaker && !v.speaker_ru) errors.push('Speaker is required.');
    if (!v.title_en && !v.title_ru) errors.push('A title in at least one language is required.');
    if (v.number && !/^\d{1,5}$/.test(v.number)) errors.push('Seminar number must be a whole number.');
    for (const [k, label] of [['slides_url', 'Slides link'], ['minutes_url', 'Minutes link']]) {
      if (v[k] && !URL_RE.test(v[k])) errors.push(`${label}: must start with https://`);
      if (v[k] && allowedLinkHost(env, v[k])) errors.push(`${label}: Zoom and recording links belong in the protected fields above, not in the public documents.`);
    }
    const zoomIn = clean(f.get('zoom'), 2048), recIn = clean(f.get('recording'), 2048);
    for (const [val, label] of [[zoomIn, 'Zoom URL'], [recIn, 'Recording URL']]) if (val && !allowedLinkHost(env, val)) errors.push(`${label}: must be https:// on one of ${env.LINK_HOSTS || 'zoom.us, youtube.com, youtu.be'}.`);
    const photo = await fileOf(f, 'photo', /\.(jpe?g|png|webp)$/i, PHOTO_MAX, 'Photo', errors);
    const slidesFile = await fileOf(f, 'slides_file', /\.(pdf|pptx?)$/i, DOC_MAX, 'Slides', errors);
    const minutesFile = await fileOf(f, 'minutes_file', /\.(pdf|pptx?)$/i, DOC_MAX, 'Minutes', errors);
    const cur = SLUG.test(v.slug) ? await links.get(env, v.slug) : null;
    if (errors.length) return html(P.adminPage({ title: existing ? 'Edit talk' : 'New talk', main: form(v, { existing, sha: String(f.get('sha') || ''), errors, hasZoom: !!(cur && cur.zoom), hasRecording: !!(cur && cur.recording) }), who }), 422);

    try {
      // Existing record (merge: what the form does not carry — timezone, summary, photo, documents — survives).
      const file = await content.getText(env, talkPath(v.slug));
      if (!existing && file) { errors.push(`A talk with the address ${v.slug} already exists; open it from the programme to edit it, or choose another address.`); return html(P.adminPage({ title: 'New talk', main: form(v, { existing: false, errors }), who }), 422); }
      if (existing && !file) { errors.push('This talk no longer exists in the repository.'); return html(P.adminPage({ title: 'Edit talk', main: form(v, { existing: false, errors }), who }), 409); }
      if (existing && file.sha !== String(f.get('sha') || '')) { const e = new Error('stale'); e.code = 'E_CONTENT_CONFLICT'; throw e; }
      let t = {}; if (file) { try { t = JSON.parse(file.text); } catch (e) { t = {}; } }

      // Uploads first: a failed upload leaves the talk record untouched.
      const putFile = async (path, bytes, label) => { const prev = await content.getText(env, path).catch(() => null); await content.put(env, path, bytes, `${prev ? 'Update' : 'Add'} ${label} for ${v.slug}`, prev ? prev.sha : undefined); };
      if (photo) { t.photo = `${v.slug}.${photo.ext}`; await putFile(`photos/${t.photo}`, photo.bytes, 'photo'); }
      if (f.get('clear_slides') === '1') t.slides = '';
      if (f.get('clear_minutes') === '1') t.minutes = '';
      if (slidesFile) { t.slides = `${v.slug}-slides.${slidesFile.ext}`; await putFile(`files/${t.slides}`, slidesFile.bytes, 'slides'); } else if (v.slides_url) t.slides = v.slides_url;
      if (minutesFile) { t.minutes = `${v.slug}-minutes.${minutesFile.ext}`; await putFile(`files/${t.minutes}`, minutesFile.bytes, 'minutes'); } else if (v.minutes_url) t.minutes = v.minutes_url;

      // Protected links: empty = keep; the checkbox clears; the public flags follow what is stored.
      const zoom = f.get('clear_zoom') === '1' ? '' : (zoomIn || (cur && cur.zoom) || '');
      const recording = f.get('clear_recording') === '1' ? '' : (recIn || (cur && cur.recording) || '');
      if (zoom || recording) await links.put(env, v.slug, zoom, recording); else if (cur) await links.remove(env, v.slug);

      const built = await programme(env);
      const number = v.number ? Number(v.number) : (t.number || (built.reduce((m, x) => Math.max(m, Number(x.number) || 0), 0) + 1));
      const record = {
        number, slug: v.slug,
        speaker: nameField(v.speaker, v.speaker_ru), affiliation: nameField(v.affiliation, v.affiliation_ru),
        photo: t.photo || '', date: v.date, time: v.time, language: v.language,
        title: bilingual(v.title_en, v.title_ru), abstract: bilingual(v.abstract_en, v.abstract_ru), bio: bilingual(v.bio_en, v.bio_ru),
        join: !!zoom, recording: !!recording, slides: t.slides || '', minutes: t.minutes || ''
      };
      for (const k of Object.keys(t)) if (!(k in record)) record[k] = t[k];   // timezone, summary, duration and the like
      await content.put(env, talkPath(v.slug), JSON.stringify(record, null, 2) + '\n', `${existing ? 'Update' : 'Add'} seminar ${v.slug}`, file ? file.sha : undefined);
    } catch (e) {
      const msg = contentError(e);
      if (!msg) throw e;
      errors.push(msg);
      return html(P.adminPage({ title: existing ? 'Edit talk' : 'New talk', main: form(v, { existing, sha: String(f.get('sha') || ''), errors, hasZoom: !!(cur && cur.zoom), hasRecording: !!(cur && cur.recording) }), who }), e.code === 'E_CONTENT_CONFLICT' ? 409 : 502);
    }
    return redirect(`/admin/talks?s=saved&slug=${encodeURIComponent(v.slug)}`);
  }

  if (sub === '/talks/delete') {
    if (!isPost) return new Response('Method not allowed', { status: 405 });
    const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
    const slug = clean(f.get('slug'), 120);
    if (!SLUG.test(slug)) return new Response('Bad request', { status: 400 });
    try {
      const file = await content.getText(env, talkPath(slug));
      if (file) await content.remove(env, talkPath(slug), `Remove seminar ${slug}`, file.sha);
    } catch (e) {
      const msg = contentError(e); if (!msg) throw e;
      return page('Programme', `<section class="sec"><div class="sec-label"></div><div class="sec-body"><p class="form-status">${esc(msg)}</p><p class="actions"><a class="more" href="/admin/talks">Back</a></p></div></section>`);
    }
    await links.remove(env, slug);
    return redirect('/admin/talks?s=deleted');
  }
  return new Response('Not found', { status: 404 });
}
