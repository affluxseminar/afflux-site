import { currentSession, rememberNext, html, redirect } from './auth.js';
import { links } from '../db.js';
import { clearSessionCookies } from '../cookies.js';
import * as P from '../pages.js';

/* /go/join/<slug>/ and /go/recording/<slug>/ — the only way to a protected URL.
   The destination is looked up after the session and the account have been verified. */
export async function getGo(req, env, lang, kind, slug) {
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return new Response('Not found', { status: 404 });
  const s = await currentSession(req, env);
  const a = P.ta(lang);
  if (!s || !s.user) {
    const path = P.urlFor(lang, `/go/${kind}/${slug}/`);
    const cookie = await rememberNext(env, path);
    return html(P.gatePage(lang, kind), 401, [...(s ? [] : clearSessionCookies(env)), ...(cookie ? [cookie] : [])]);
  }
  const row = await links.get(env, slug);
  const url = row && (kind === 'join' ? row.zoom : row.recording);
  if (!url) return html(P.messagePage(lang, 'account', a.notAvailableTitle, a.notAvailableText, { href: P.urlFor(lang, `/talks/${slug}/`), label: P.t(lang).details }), 404, s.cookies);
  return redirect(url, s.cookies);
}
