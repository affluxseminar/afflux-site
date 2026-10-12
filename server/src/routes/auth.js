import { identity } from '../identity/index.js';
import { users, pending } from '../db.js';
import { sign, verify, randomToken, sha256, keyedHash } from '../crypto.js';
import { parseCookies, setCookie, clearCookie, sessionCookies, clearSessionCookies, SESSION_COOKIE, NEXT_COOKIE, INIT_COOKIE, CONFIRM_COOKIE } from '../cookies.js';
import { allowLinkRequest, isEmail, clean, safeNext, readFields } from '../security.js';
import { throttle } from '../db.js';
import { createMail } from '../mail.js';
import * as P from '../pages.js';

const mailFrom = (env) => ((env.MAIL_FROM || '').match(/<([^>]+)>/) || [null, env.MAIL_FROM || ''])[1];

const html = (body, status = 200, headers = []) => {
  const h = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
  for (const c of headers) h.append('Set-Cookie', c);
  return new Response(body, { status, headers: h });
};
const redirect = (to, headers = []) => {
  const h = new Headers({ Location: to });
  for (const c of headers) h.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers: h });
};
export { html, redirect };

/* Session lookup used by every protected route. When the store slides the expiry, the cookie follows. */
export async function currentSession(req, env) {
  const token = parseCookies(req)[SESSION_COOKIE(env)];
  if (!token) return null;
  const s = await identity(env).authenticateSession(token);
  if (!s) return null;
  const user = await users.get(env, s.userId);
  return { userId: s.userId, sessionToken: s.sessionToken, user, cookies: s.slid ? sessionCookies(env, s.sessionToken) : [] };
}

export async function rememberNext(env, path) {
  const n = safeNext(path);
  if (!n) return null;
  return setCookie(env, NEXT_COOKIE(env), await sign(env, { n }, 3600), { maxAge: 3600 });
}
async function takeNext(req, env) {
  const c = parseCookies(req)[NEXT_COOKIE(env)];
  if (!c) return null;
  const p = await verify(env, c);
  return p ? safeNext(p.n) : null;
}

/* The browser that asks for a link gets a random nonce; the token remembers its hash. A link opened
   elsewhere still works (cross-device) but the confirmation page says so and names the account. */
function initNonce(req, env) {
  const existing = parseCookies(req)[INIT_COOKIE(env)];
  const nonce = /^[A-Za-z0-9_-]{20,64}$/.test(existing || '') ? existing : randomToken(24);
  return { nonce, cookie: setCookie(env, INIT_COOKIE(env), nonce, { maxAge: 24 * 3600 }) };
}

const readForm = readFields;
const langOf = (form, req) => (form && form.lang === 'ru') || new URL(req.url).pathname.startsWith('/ru/') ? 'ru' : 'en';

export async function getRegister(req, env, lang) {
  const s = await currentSession(req, env);
  if (s && s.user) return redirect(P.urlFor(lang, '/account/'), s.cookies);
  const next = new URL(req.url).searchParams.get('next');
  const cookie = next ? await rememberNext(env, next) : null;
  return html(P.registerPage(lang), 200, cookie ? [cookie] : []);
}
export async function getSignin(req, env, lang) {
  const s = await currentSession(req, env);
  if (s && s.user) return redirect(P.urlFor(lang, '/account/'), s.cookies);
  const next = new URL(req.url).searchParams.get('next');
  const cookie = next ? await rememberNext(env, next) : null;
  return html(P.signinPage(lang), 200, cookie ? [cookie] : []);
}

export async function postRegister(req, env) {
  const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
  const lang = langOf(f, req); const a = P.ta(lang);
  if (f.website) return html(P.checkEmailPage(lang, clean(f.email, 254), env.SIGNUP_LINK_HOURS || 24, mailFrom(env)));
  const values = { name: clean(f.name, 120), email: clean(f.email, 254), affiliation: clean(f.affiliation, 200), pref_ru: f.list_ru === '1', pref_en: f.list_en === '1' };
  const errors = {};
  if (!values.name) errors.name = a.errName;
  if (!isEmail(values.email)) errors.email = a.errInvalidEmail;
  if (Object.keys(errors).length) return html(P.registerPage(lang, { values, errors }), 422);
  if (!(await allowLinkRequest(env, req, values.email))) return html(P.registerPage(lang, { values, errors: { form: a.errTooMany } }), 429);
  const init = initNonce(req, env);
  let r;
  try {
    r = await identity(env).sendLink({ email: values.email, lang, initNonce: init.nonce });
  } catch (e) {
    return html(P.registerPage(lang, { values, errors: { form: a.errGeneric } }), 502);
  }
  if (r.created) await pending.put(env, { auth_user_id: r.userId, ...values }, Number(env.PENDING_HOURS || 24));
  return html(P.checkEmailPage(lang, values.email, env.SIGNUP_LINK_HOURS || 24, mailFrom(env)), 200, [init.cookie]);
}

export async function postSignin(req, env) {
  const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
  const lang = langOf(f, req); const a = P.ta(lang);
  const email = clean(f.email, 254);
  if (f.website) return html(P.checkEmailPage(lang, email, env.SIGNUP_LINK_HOURS || 24, mailFrom(env)));
  if (!isEmail(email)) return html(P.signinPage(lang, { values: { email }, errors: { email: a.errInvalidEmail } }), 422);
  if (!(await allowLinkRequest(env, req, email))) return html(P.signinPage(lang, { values: { email }, errors: { form: a.errTooMany } }), 429);
  const init = initNonce(req, env);
  try {
    await identity(env).sendLink({ email, lang, initNonce: init.nonce });
  } catch (e) {
    return html(P.signinPage(lang, { values: { email }, errors: { form: a.errGeneric } }), 502);
  }
  const mins = Number(env.LOGIN_LINK_MINUTES || 20);
  return html(P.checkEmailPage(lang, email, mins >= 60 ? Math.round(mins / 60) : `0.${Math.round(mins / 6)}`, mailFrom(env), mins), 200, [init.cookie]);
}

/* The link lands here. The token is taken out of the address at once: its hash goes into a
   signed five-minute cookie and the browser is redirected to the same page without the query, so
   no Referer, history entry or asset request carries the token. The page then names the account
   (masked), says whether this is the browser that asked for the link, and refuses to switch an
   already signed-in visitor into a different account. The token is consumed only on the POST. */
export async function getVerify(req, env, lang) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (token !== null) {
    if (!/^[A-Za-z0-9._=-]{16,512}$/.test(token)) return html(P.verifyPage(lang, { failed: true }), 400);
    const cookie = setCookie(env, CONFIRM_COOKIE(env), await sign(env, { h: await sha256(token) }, 300), { maxAge: 300 });
    return redirect(P.urlFor(lang, '/account/verify'), [cookie]);
  }
  const c = await verify(env, parseCookies(req)[CONFIRM_COOKIE(env)]);
  if (!c || !c.h) return html(P.verifyPage(lang, { failed: true }), 400);
  const info = await identity(env).inspectLink({ hash: c.h, initNonce: parseCookies(req)[INIT_COOKIE(env)] });
  if (!info) return html(P.verifyPage(lang, { failed: true }), 400);
  const s = await currentSession(req, env);
  if (s && s.userId !== info.identityId) return html(P.verifyPage(lang, { foreign: true, masked: info.masked }), 409, s.cookies);
  if (env.LINK_BINDING === 'strict' && !info.sameBrowser) return html(P.verifyPage(lang, { failed: true, strict: true }), 403);
  // The form carries a keyed commitment to this token: a page left open while another link landed
  // in the same browser cannot confirm the newer token.
  return html(P.verifyPage(lang, { masked: info.masked, sameBrowser: info.sameBrowser, form: await keyedHash(env, 'confirm-form', c.h) }), 200, s ? s.cookies : []);
}

export async function postVerify(req, env) {
  const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
  const lang = langOf(f, req);
  const c = await verify(env, parseCookies(req)[CONFIRM_COOKIE(env)]);
  if (!c || !c.h) return html(P.verifyPage(lang, { failed: true }), 400);
  const info = await identity(env).inspectLink({ hash: c.h, initNonce: parseCookies(req)[INIT_COOKIE(env)] });
  if (!info) return html(P.verifyPage(lang, { failed: true }), 400);
  const existing = await currentSession(req, env);
  if (existing && existing.userId !== info.identityId) return html(P.verifyPage(lang, { foreign: true, masked: info.masked }), 409);
  if (env.LINK_BINDING === 'strict' && !info.sameBrowser) return html(P.verifyPage(lang, { failed: true, strict: true }), 403);
  if (String(f.c || '') !== await keyedHash(env, 'confirm-form', c.h)) {
    // Stale form: show the account this browser's current confirmation actually belongs to, consume nothing.
    return html(P.verifyPage(lang, { stale: true, masked: info.masked, sameBrowser: info.sameBrowser, form: await keyedHash(env, 'confirm-form', c.h) }), 409);
  }
  let r;
  try {
    r = await identity(env).authenticateLink({ hash: c.h });
  } catch (e) {
    return html(P.verifyPage(lang, { failed: true }), 400);
  }
  const cookies = [...sessionCookies(env, r.sessionToken), clearCookie(env, INIT_COOKIE(env)), clearCookie(env, CONFIRM_COOKIE(env))];
  let user = await users.get(env, r.userId);
  if (!user) {
    const p = await pending.take(env, r.userId);
    if (p) {
      await users.create(env, { auth_user_id: r.userId, name: p.name, affiliation: p.affiliation, pref_ru: p.pref_ru, pref_en: p.pref_en });
      user = await users.get(env, r.userId);
    }
  }
  if (!user) return html(P.completePage(lang), 200, cookies);
  const next = await takeNext(req, env);
  return redirect(next || P.urlFor(lang, '/account/'), [...cookies, clearCookie(env, NEXT_COOKIE(env))]);
}

export async function postProfile(req, env) {
  const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
  const lang = langOf(f, req); const a = P.ta(lang);
  const s = await currentSession(req, env);
  if (!s) return redirect(P.urlFor(lang, '/signin/'), clearSessionCookies(env));
  if (s.user) return redirect(P.urlFor(lang, '/account/'), s.cookies);
  const values = { name: clean(f.name, 120), affiliation: clean(f.affiliation, 200), pref_ru: f.list_ru === '1', pref_en: f.list_en === '1' };
  if (!values.name) return html(P.completePage(lang, { values, errors: { name: a.errName } }), 422, s.cookies);
  await users.create(env, { auth_user_id: s.userId, ...values });
  const next = await takeNext(req, env);
  return redirect(next || P.urlFor(lang, '/account/'), [...s.cookies, clearCookie(env, NEXT_COOKIE(env))]);
}

export async function getAccount(req, env, lang) {
  const s = await currentSession(req, env);
  if (!s) return redirect(P.urlFor(lang, '/signin/'), clearSessionCookies(env));
  if (!s.user) return html(P.completePage(lang), 200, s.cookies);
  const st = new URL(req.url).searchParams.get('s');
  const a = P.ta(lang);
  return html(P.accountPage(lang, s.user, { status: st === 'saved' ? a.saved : '' }), 200, s.cookies);
}

export async function postAccount(req, env) {
  const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
  const lang = langOf(f, req); const a = P.ta(lang);
  const s = await currentSession(req, env);
  if (!s || !s.user) return redirect(P.urlFor(lang, '/signin/'), clearSessionCookies(env));
  const values = { name: clean(f.name, 120), affiliation: clean(f.affiliation, 200), pref_ru: f.list_ru === '1', pref_en: f.list_en === '1' };
  if (!values.name) return html(P.accountPage(lang, { ...s.user, ...values }, { errors: { name: a.errName } }), 422, s.cookies);
  await users.update(env, s.userId, values);
  return redirect(P.urlFor(lang, '/account/?s=saved'), s.cookies);
}

/* Comments and suggestions. The account must be complete (name on file); five messages an hour
   per account; the text is mailed to the seminar and not stored. Control characters other than
   line breaks are removed; the body is plain text, never interpreted. */
const cleanText = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);

export async function getFeedback(req, env, lang) {
  const s = await currentSession(req, env);
  if (!s) return redirect(P.urlFor(lang, '/signin/?next=' + encodeURIComponent(P.urlFor(lang, '/account/feedback'))), clearSessionCookies(env));
  if (!s.user) return html(P.completePage(lang), 200, s.cookies);
  const a = P.ta(lang);
  const sent = new URL(req.url).searchParams.get('s') === 'sent';
  return html(P.feedbackPage(lang, { sent, status: sent ? a.feedbackSent : '' }), 200, s.cookies);
}

export async function postFeedback(req, env) {
  const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
  const lang = langOf(f, req); const a = P.ta(lang);
  const s = await currentSession(req, env);
  if (!s || !s.user) return redirect(P.urlFor(lang, '/signin/'), clearSessionCookies(env));
  const values = { subject: clean(f.subject, 150), message: cleanText(f.message, 6000) };
  if (!values.message) return html(P.feedbackPage(lang, { values, errors: { message: a.errFeedback } }), 422, s.cookies);
  if (!(await throttle.hit(env, await keyedHash(env, 'throttle', 'fb:' + s.userId), 5, 3600))) return html(P.feedbackPage(lang, { values, errors: { form: a.errFeedbackLimit } }), 429, s.cookies);
  const who = await identity(env).getUser(s.userId);
  if (!who || who.status !== 'active') return redirect(P.urlFor(lang, '/signin/'), clearSessionCookies(env));
  const r = await createMail(env).sendFeedback({ from: who.email, name: s.user.name, affiliation: s.user.affiliation || '', subject: values.subject, text: values.message, lang });
  if (!r.ok) return html(P.feedbackPage(lang, { values, errors: { form: a.errGeneric } }), 502, s.cookies);
  return redirect(P.urlFor(lang, '/account/feedback?s=sent'), s.cookies);
}

export async function postSignout(req, env) {
  const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
  const lang = langOf(f, req); const a = P.ta(lang);
  const token = parseCookies(req)[SESSION_COOKIE(env)];
  if (token) {
    const id = identity(env);
    if (f.all === '1') { const s = await id.authenticateSession(token); if (s) await id.revokeAllSessions(s.userId); }
    else await id.revokeSession(token);
  }
  return html(P.messagePage(lang, 'signin', a.signedOut, '', { href: P.urlFor(lang, '/'), label: P.t(lang).toHome }), 200, clearSessionCookies(env));
}

export async function postDelete(req, env) {
  const f = await readForm(req); if (!f) return new Response('Bad request', { status: 400 });
  const lang = langOf(f, req); const a = P.ta(lang);
  const s = await currentSession(req, env);
  if (!s) return redirect(P.urlFor(lang, '/signin/'), clearSessionCookies(env));
  const id = identity(env);
  await users.remove(env, s.userId);
  await pending.remove(env, s.userId);
  await id.revokeAllSessions(s.userId);
  await id.deleteUser(s.userId);
  return html(P.messagePage(lang, 'signin', a.deleted, '', { href: P.urlFor(lang, '/'), label: P.t(lang).toHome }), 200, clearSessionCookies(env));
}
