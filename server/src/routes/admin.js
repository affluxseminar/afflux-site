import { verifyAccess } from '../access.js';
import { identity } from '../identity/index.js';
import { users, links, sends } from '../db.js';
import { createMail } from '../mail.js';
import { unsubscribeUrl } from './unsubscribe.js';
import { html, redirect } from './auth.js';
import { clean, allowedLinkHost, readForm } from '../security.js';
import { randomToken } from '../crypto.js';
import * as P from '../pages.js';
import { talksAdmin } from './talks.js';

const esc = P.esc;
const CHUNK = 20;

async function programme(env) {
  try {
    const r = await fetch(`${env.SITE_BASE}/programme.json`, { cf: { cacheTtl: 60 } });
    if (!r.ok) return [];
    return (await r.json()).talks || [];
  } catch (e) { return []; }
}

/* Processes one claimed chunk of a job. POST only; the caller has passed Access and the same-origin
   check, and the operator has pressed Start. Claim (one statement, fresh attempt id), recheck the
   recipients' current preferences (one query), send, record the outcomes (one batch) — a late
   completion from an older attempt cannot touch a row that a newer attempt owns. Nothing is retried
   automatically; an ambiguous transport result is `unknown`. */
async function runChunk(env, job) {
  const { attempt, ids } = await sends.claim(env, job.id, CHUNK);
  if (!ids.length) return;
  const stillOn = await users.prefsFor(env, ids, job.list);
  const emails = await identity(env).getEmails(ids.filter((u) => stillOn.has(u)));
  const mail = createMail(env);
  const outcomes = [];
  for (const uid of ids) {
    // The chunk-level check decides what to decrypt; this one, immediately before the send, decides whether to send.
    if (!stillOn.has(uid) || !emails.get(uid) || !(await users.hasPref(env, uid, job.list))) { outcomes.push([uid, 'skipped']); continue; }
    let state = 'unknown';
    try {
      const r = await mail.sendAnnouncement({ to: emails.get(uid), subject: job.subject, text: job.body, unsubscribeUrl: await unsubscribeUrl(env, uid, job.list), lang: job.list });
      state = r.ok ? 'sent' : (r.status >= 400 && r.status < 500 ? 'failed' : 'unknown');
    } catch (e) { state = 'unknown'; }
    outcomes.push([uid, state]);
  }
  await sends.markMany(env, job.id, attempt, outcomes);
}

const progressPage = (job, who, note) => {
  const c = job.counts;
  const running = job.status === 'running';
  const started = !!job.started_at;
  const main = `<section class="sec"><h2 class="sec-label">${running ? (started ? 'Sending' : 'Ready') : (job.status === 'initializing' ? 'Preparing' : 'Result')}</h2><div class="sec-body">
<p class="lede">"${esc(job.subject)}" to the ${job.list.toUpperCase()} list.</p>
<dl class="kv"><dt>Recipients</dt><dd>${job.total} of ${job.intended} intended</dd><dt>Sent</dt><dd>${c.sent}</dd><dt>Skipped (unsubscribed meanwhile)</dt><dd>${c.skipped}</dd><dt>Failed (rejected by the mail service)</dt><dd>${c.failed}</dd><dt>Unknown (no answer from the mail service)</dt><dd>${c.unknown}</dd><dt>Still to send</dt><dd>${c.pending + c.sending}</dd></dl>
${note ? `<p class="form-status">${esc(note)}</p>` : ''}
${job.status === 'initializing' ? `<p class="note">The recipient list is still being written (${job.total} of ${job.intended}). Reload in a moment; if this persists, submit the confirmation again — it completes the list rather than creating a second job.</p>` : ''}
${running && !started ? `<form class="form" method="post" action="/admin/announce/run?id=${esc(job.id)}"><input type="hidden" name="start" value="1"><p class="actions"><button class="btn" type="submit">Start sending</button><a class="more" href="/admin/">Not now</a></p><p class="note">Nothing is sent until you press Start. Afterwards the page continues by itself while it stays open.</p></form>` : ''}
${running && started ? `<form class="form" method="post" action="/admin/announce/run?id=${esc(job.id)}" data-autosubmit="800"><p class="actions"><button class="btn" type="submit">Continue sending</button></p><p class="note">Started by you; continues while this page stays open. Closing the page pauses it — reopen and press Continue.</p></form>` : ''}
${!running && job.status === 'done' ? `<p class="actions"><a class="btn" href="/admin/">Overview</a>${c.failed || c.unknown ? `</p><form class="form" method="post" action="/admin/announce/retry?id=${esc(job.id)}"><p class="actions"><button class="btn btn-quiet" type="submit" name="scope" value="failed">Retry failed (${c.failed})</button><button class="btn btn-quiet" type="submit" name="scope" value="all">Retry failed and unknown (${c.failed + c.unknown}) — may duplicate</button></p></form>` : '</p>'}` : ''}
</div></section>`;
  return P.adminPage({ title: 'Announcement', main, who });
};

export async function admin(req, env, sub) {
  const who = await verifyAccess(req, env);
  if (!who) return new Response('Forbidden', { status: 403 });
  const url = new URL(req.url);
  const isPost = req.method === 'POST';
  if (sub === '/talks' || sub.startsWith('/talks/')) return talksAdmin(req, env, sub, who.email);

  if (sub === '' || sub === '/') {
    if (isPost) return new Response('Method not allowed', { status: 405 });
    const c = await users.counts(env);
    const recent = await sends.recent(env);
    const main = `<section class="sec"><h2 class="sec-label">Accounts</h2><div class="sec-body"><dl class="kv">
<dt>Registered</dt><dd>${c.total}</dd><dt>English list</dt><dd>${c.en}</dd><dt>Russian list</dt><dd>${c.ru}</dd><dt>Pending registrations</dt><dd>${c.pending}</dd></dl></div></section>
<section class="sec"><h2 class="sec-label">Recent announcements</h2><div class="sec-body">${recent.length ? `<ol class="ledger">${recent.map((r) => `<li class="row"><time class="row-date">${esc(r.created_at.slice(0, 10))}</time><span class="row-who">${esc(r.list.toUpperCase())}</span><a class="row-title" href="/admin/announce/run?id=${esc(r.id)}">${esc(r.subject)}</a><span class="row-lang">${r.sent}/${r.total}${r.status === 'running' ? ' …' : ''}</span><span class="row-links"></span></li>`).join('')}</ol>` : '<p class="note">None yet.</p>'}</div></section>
<section class="sec"><h2 class="sec-label">Programme</h2><div class="sec-body"><p class="actions"><a class="btn" href="/admin/talks/new">New talk</a><a class="more" href="/admin/talks">All talks</a></p></div></section>
<section class="sec"><h2 class="sec-label">Maintenance</h2><div class="sec-body"><p class="note"><a href="/admin/maintenance">Key migrations and session revocation</a></p></div></section>`;
    return html(P.adminPage({ title: 'Overview', main, who: who.email }));
  }

  if (sub === '/links') {
    if (isPost) {
      const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
      const slug = clean(f.get('slug'), 120);
      if (!/^[A-Za-z0-9._-]+$/.test(slug)) return new Response('Invalid slug', { status: 422 });
      if (f.get('delete') === '1') { await links.remove(env, slug); return redirect('/admin/links'); }
      const zoom = clean(f.get('zoom'), 2048), recording = clean(f.get('recording'), 2048);
      for (const v of [zoom, recording]) if (v && !allowedLinkHost(env, v)) return new Response(`Links must be https:// on one of: ${env.LINK_HOSTS || 'zoom.us, youtube.com, youtu.be'}`, { status: 422 });
      await links.put(env, slug, zoom, recording);
      return redirect('/admin/links');
    }
    const stored = await links.all(env);
    const talks = await programme(env);
    const byslug = new Map(stored.map((l) => [l.slug, l]));
    const rows = talks.map((t) => {
      const l = byslug.get(t.slug) || {};
      return `<li class="row row-block"><form class="form form-wide" method="post" action="/admin/links">
<input type="hidden" name="slug" value="${esc(t.slug)}">
<p><strong>${esc(t.date)}</strong> — ${esc(P.L(t.title, 'en') || P.L(t.title, 'ru'))} — ${esc(P.L(t.speaker, 'en'))} <span class="note">(${esc(t.status)}; buttons: join=${t.join}, recording=${t.recording})</span></p>
<div class="field"><label>Zoom URL${l.has_zoom ? ' (set)' : ''}</label><input type="text" name="zoom" placeholder="https://…zoom.us/…"></div>
<div class="field"><label>Recording URL${l.has_recording ? ' (set)' : ''}</label><input type="text" name="recording" placeholder="https://www.youtube.com/…"></div>
<p class="actions"><button class="btn" type="submit">Save</button><button class="btn btn-quiet" type="submit" name="delete" value="1">Remove stored links</button><a class="more" href="/admin/announce?slug=${esc(t.slug)}">Announce this session</a></p>
<p class="note">Saving replaces both values; leave a field empty to clear it. Stored values are never shown back. For the recording: schedule the YouTube live stream in YouTube Studio beforehand (unlisted) and paste its URL here before the session — it becomes the recording as soon as the stream ends.</p></form></li>`;
    }).join('');
    const orphans = stored.filter((l) => !talks.some((t) => t.slug === l.slug));
    const main = `<section class="sec"><h2 class="sec-label">Programme</h2><div class="sec-body">${rows ? `<ol class="ledger">${rows}</ol>` : '<p class="note">No talks in programme.json yet. Add the talk to talks.json and deploy the site first.</p>'}</div></section>
${orphans.length ? `<section class="sec"><h2 class="sec-label">Stored without a talk</h2><div class="sec-body"><ul>${orphans.map((o) => `<li>${esc(o.slug)}</li>`).join('')}</ul></div></section>` : ''}`;
    return html(P.adminPage({ title: 'Protected links', main, who: who.email }));
  }

  /* GET: progress only. POST: one claimed chunk, then back to the GET view. */
  if (sub === '/announce/run') {
    const id = url.searchParams.get('id') || '';
    if (!/^s_[0-9a-f]{32}$/.test(id)) return new Response('Not found', { status: 404 });
    let job = await sends.get(env, id);
    if (!job) return new Response('Not found', { status: 404 });
    if (isPost) {
      const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
      if (job.status === 'running') {
        if (!job.started_at) { if (f.get('start') === '1') await sends.start(env, id); else return redirect(`/admin/announce/run?id=${id}`); }
        job = await sends.get(env, id);
        if (job.started_at) { await runChunk(env, job); await sends.finishIfDone(env, id); }
      }
      return redirect(`/admin/announce/run?id=${id}`);
    }
    return html(progressPage(job, who.email));
  }
  if (sub === '/announce/retry') {
    if (!isPost) return new Response('Method not allowed', { status: 405 });
    const id = url.searchParams.get('id') || '';
    if (!/^s_[0-9a-f]{32}$/.test(id)) return new Response('Not found', { status: 404 });
    const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
    await sends.retry(env, id, f.get('scope') === 'all');
    return redirect(`/admin/announce/run?id=${id}`);
  }

  if (sub === '/announce') {
    if (isPost) {
      const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
      const list = f.get('list') === 'ru' ? 'ru' : 'en';
      const subject = clean(f.get('subject'), 200);
      const text = String(f.get('text') || '').replace(/\r\n/g, '\n').slice(0, 20000).trim();
      const confirm = f.get('confirm') === 'yes';
      const idem = String(f.get('idem') || '');
      if (!subject || !text) return new Response('Subject and text are required', { status: 422 });
      const ids = await users.idsForList(env, list);
      if (!confirm) {
        const main = `<section class="sec"><h2 class="sec-label">Confirm</h2><div class="sec-body"><form class="form" method="post" action="/admin/announce">
<input type="hidden" name="list" value="${list}"><input type="hidden" name="subject" value="${esc(subject)}"><input type="hidden" name="text" value="${esc(text)}"><input type="hidden" name="confirm" value="yes"><input type="hidden" name="idem" value="${randomToken(16)}">
<p class="lede">Send "${esc(subject)}" to the ${list.toUpperCase()} list — ${ids.length} recipients?</p>
<pre class="prose pre-wrap">${esc(text)}</pre>
<p class="actions"><button class="btn" type="submit">Send now</button><a class="more" href="/admin/announce">Back</a></p></form></div></section>`;
        return html(P.adminPage({ title: 'Announcement', main, who: who.email }));
      }
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(idem)) return new Response('Bad request', { status: 400 });
      let jobId;
      try {
        jobId = await sends.create(env, { idemKey: idem, list, subject, body: text, targets: ids });
      } catch (e) { if (e.status === 409) return new Response('This confirmation was already used for a different announcement', { status: 409 }); throw e; }
      return redirect(`/admin/announce/run?id=${jobId}`);
    }
    const c = await users.counts(env);
    let pre = { list: 'en', subject: '', text: '' };
    const slug = url.searchParams.get('slug');
    if (slug) {
      const talk = (await programme(env)).find((x) => x.slug === slug);
      if (talk) {
        const lang = talk.language === 'ru' ? 'ru' : 'en';
        const L = (v) => (v && typeof v === 'object') ? (v[lang] || v.en || v.ru || '') : (v || '');
        const start = new Date(`${talk.date}T${talk.time}:00`);
        const date = new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: talk.timezone }).format(start).replace(/ г\.$/, '');
        const pageUrl = `${env.SITE_BASE}${lang === 'ru' ? '/ru' : ''}/talks/${talk.slug}/`;
        const whoT = L(talk.speaker) + (talk.affiliation ? ` (${L(talk.affiliation)})` : '');
        const abs = String(L(talk.abstract)).split(/\n\s*\n/)[0];
        pre = lang === 'ru'
          ? { list: 'ru', subject: `AFFLUX, ${date}: ${L(talk.title)}`, text: `Семинар «Экономика энергетики и окружающей среды» (AFFLUX)\n${date}, ${talk.time} по московскому времени\n\n${whoT}\n${L(talk.title)}\n\n${abs}\n\nПодробности, подключение и ссылка на запись: ${pageUrl}` }
          : { list: 'en', subject: `AFFLUX, ${date}: ${L(talk.title)}`, text: `Seminar on the Economics of Energy and the Environment (AFFLUX)\n${date}, ${talk.time} Moscow time\n\n${whoT}\n${L(talk.title)}\n\n${abs}\n\nDetails, joining and the recording: ${pageUrl}` };
      }
    }
    const main = `<section class="sec"><h2 class="sec-label">Compose</h2><div class="sec-body"><form class="form" method="post" action="/admin/announce">
<div class="check"><input type="radio" id="l_en" name="list" value="en"${pre.list === 'en' ? ' checked' : ''}><label for="l_en">English-language sessions list (${c.en})</label></div>
<div class="check"><input type="radio" id="l_ru" name="list" value="ru"${pre.list === 'ru' ? ' checked' : ''}><label for="l_ru">Russian-language sessions list (${c.ru})</label></div>
<div class="field"><label for="subject">Subject</label><input id="subject" type="text" name="subject" maxlength="200" required value="${esc(pre.subject)}"></div>
<div class="field"><label for="text">Text (plain text; the unsubscribe line is added automatically)</label><textarea id="text" name="text" rows="14" required class="ta">${esc(pre.text)}</textarea></div>
<p class="actions"><button class="btn" type="submit">Preview</button></p></form></div></section>`;
    return html(P.adminPage({ title: 'Announcement', main, who: who.email }));
  }

  /* Key migrations and emergency actions. Each POST does a bounded amount of work and reports it. */
  if (sub === '/maintenance') {
    let note = '';
    if (isPost) {
      const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
      const action = String(f.get('action') || '');
      const id = identity(env);
      if (action === 'reindex') { const n = await id.reindex(100); note = `Reindexed ${n} identities this pass.`; }
      else if (action === 'reencrypt') { const n = (await id.reencrypt(100)) + (await users.reencrypt(env, 100)) + (await sends.reencrypt(env, 100)) + (await links.reencrypt(env, 100)); note = `Re-encrypted ${n} values this pass.`; }
      else if (action === 'revoke-all') { await identity(env).revokeEverySession(); note = 'Every session is revoked; everyone signs in again by link.'; }
      else return new Response('Bad request', { status: 400 });
    }
    const id = identity(env);
    const st = await id.migrationStatus(env);
    const remainEnc = st.encryptionRemaining + await users.migrationStatus(env) + await sends.migrationStatus(env) + await links.migrationStatus(env);
    const main = `<section class="sec"><h2 class="sec-label">Keys</h2><div class="sec-body prose">
${note ? `<p class="form-status">${esc(note)}</p>` : ''}
<dl class="kv"><dt>Rows not yet on the current INDEX_KEY</dt><dd>${st.indexRemaining}</dd><dt>Values not yet under the current DATA_KEY (all stores)</dt><dd>${remainEnc}</dd><dt>INDEX_KEY_PREVIOUS configured</dt><dd>${env.INDEX_KEY_PREVIOUS ? 'yes' : 'no'}</dd><dt>DATA_KEY_PREVIOUS configured</dt><dd>${env.DATA_KEY_PREVIOUS ? 'yes' : 'no'}</dd></dl>
<p>Rotation order. <strong>INDEX_KEY</strong>: set the new value as INDEX_KEY and the old as INDEX_KEY_PREVIOUS, deploy, press Reindex until the first counter is 0, then remove INDEX_KEY_PREVIOUS. Lookups keep working throughout. <strong>DATA_KEY</strong>: same with DATA_KEY_PREVIOUS and Re-encrypt until the second counter is 0 — it covers addresses, profiles, pending profiles, announcements and links. Only then remove DATA_KEY_PREVIOUS from the configuration — and keep the old key's offline copy for as long as any backup that used it exists. <strong>SIGNING_KEY</strong>: replace at will; sessions are unaffected (revoke them below if the key was exposed).</p>
${(st.indexRemaining === 0 && remainEnc === 0) ? '<p class="form-status">All rows are on the current keys.</p>' : ''}
<form class="form" method="post" action="/admin/maintenance"><p class="actions"><button class="btn btn-quiet" type="submit" name="action" value="reindex">Reindex (INDEX_KEY)</button><button class="btn btn-quiet" type="submit" name="action" value="reencrypt">Re-encrypt (DATA_KEY)</button></p></form>
</div></section>
<section class="sec"><h2 class="sec-label">Emergency</h2><div class="sec-body"><form class="form" method="post" action="/admin/maintenance"><p class="actions"><button class="btn btn-quiet" type="submit" name="action" value="revoke-all">Sign everyone out</button></p><p class="note">Use after a suspected leak of session tokens. Participants sign in again by link.</p></form></div></section>`;
    return html(P.adminPage({ title: 'Maintenance', main, who: who.email }));
  }
  return new Response('Not found', { status: 404 });
}
