import { verify, sign } from '../crypto.js';
import { users } from '../db.js';
import { html } from './auth.js';
import { readForm } from '../security.js';
import * as P from '../pages.js';

export const unsubscribeUrl = async (env, userId, list) =>
  `${env.SITE_BASE}${list === 'ru' ? '/ru' : ''}/api/unsubscribe?t=${encodeURIComponent(await sign(env, { u: userId, l: list }, 60 * 24 * 3600))}`;

export async function getUnsubscribe(req, env, lang) {
  const t = new URL(req.url).searchParams.get('t') || '';
  const p = await verify(env, t);
  return html(P.unsubscribePage(lang, t, false, !p), p ? 200 : 400);
}

/* POST from the page button, or one-click from a mail client (RFC 8058). Origin check is skipped
   deliberately: the signed, expiring token is the authorization; the only effect is switching a list off. */
export async function postUnsubscribe(req, env, lang) {
  let t = new URL(req.url).searchParams.get('t') || '';
  const f = await readForm(req);
  if (f) {
    t = String(f.get('t') || t);
    if (f.get('lang') === 'ru') lang = 'ru';
  }
  const p = await verify(env, t);
  if (!p || !p.u || !['ru', 'en'].includes(p.l)) return html(P.unsubscribePage(lang, '', false, true), 400);
  await users.setPref(env, p.u, p.l, false);
  return html(P.unsubscribePage(lang, '', true, false));
}
