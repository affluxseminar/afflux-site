/* Mail delivery through SMTP2GO's HTTP API: one message per request, nothing stored here.
   Also the sign-in link messages (plain text, both languages). */

const endpoint = (env) => (env.SMTP2GO_BASE_URL || 'https://api.smtp2go.com').replace(/\/$/, '') + '/v3/email/send';

/* Two credentials where practical: SMTP2GO_API_KEY_AUTH for sign-in links (if set) and
   SMTP2GO_API_KEY for announcements, so a leaked announcement key cannot request links. */
async function send(env, msg, purpose) {
  const key = purpose === 'auth' ? (env.SMTP2GO_API_KEY_AUTH || env.SMTP2GO_API_KEY) : env.SMTP2GO_API_KEY;
  const res = await fetch(endpoint(env), {
    method: 'POST',
    signal: AbortSignal.timeout(20000),   // a hung transport is `unknown`, not a stale claim that outlives its chunk
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Smtp2go-Api-Key': key },
    body: JSON.stringify({
      sender: env.MAIL_FROM,
      to: [msg.to],
      subject: msg.subject,
      text_body: msg.text,
      custom_headers: (msg.headers || []).map((h) => ({ header: h.name, value: h.value }))
    })
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  const ok = res.ok && data && data.data && data.data.succeeded >= 1;
  return { ok, status: res.status, error: ok ? null : ((data && data.data && (data.data.error || (data.data.failures || []).join('; '))) || `HTTP ${res.status}`) };
}

const LINK_MAIL = {
  en: (link, purpose, minutes) => ({
    subject: purpose === 'signup' ? 'Confirm your AFFLUX registration' : 'Your AFFLUX sign-in link',
    text: `${purpose === 'signup' ? 'To confirm your registration and sign in, open this link:' : 'To sign in, open this link:'}\n\n${link}\n\nIt works once and expires in ${minutes >= 60 ? Math.round(minutes / 60) + ' hour' + (minutes >= 120 ? 's' : '') : minutes + ' minutes'}. If you did not request it, ignore this message; nothing happens without the link.\n\nAFFLUX, Seminar on the Economics of Energy and the Environment`
  }),
  ru: (link, purpose, minutes) => ({
    subject: purpose === 'signup' ? 'Подтвердите регистрацию в AFFLUX' : 'Ссылка для входа в AFFLUX',
    text: `${purpose === 'signup' ? 'Чтобы подтвердить регистрацию и войти, откройте ссылку:' : 'Чтобы войти, откройте ссылку:'}\n\n${link}\n\nОна работает один раз и действует ${minutes >= 60 ? Math.round(minutes / 60) + ' ч' : minutes + ' мин'}. Если вы её не запрашивали, просто не открывайте письмо — без ссылки ничего не произойдёт.\n\nAFFLUX, семинар «Экономика энергетики и окружающей среды»`
  })
};

export function createMail(env) {
  return {
    async sendLink({ to, link, lang, purpose, minutes }) {
      const m = (LINK_MAIL[lang] || LINK_MAIL.en)(link, purpose, minutes);
      const r = await send(env, { to, subject: m.subject, text: m.text, headers: [{ name: 'Auto-Submitted', value: 'auto-generated' }] }, 'auth');
      if (!r.ok) { const e = new Error('mail: ' + r.error); e.status = 502; throw e; }
    },
    /* A participant's message to the conveners, delivered to the seminar's own address with the
       participant's address as Reply-To. The seminar address is the sender as everywhere else. */
    async sendFeedback({ from, name, affiliation, subject, text, lang }) {
      const to = env.FEEDBACK_TO || (String(env.MAIL_FROM || '').match(/<([^>]+)>/) || [null, env.MAIL_FROM])[1];
      const head = lang === 'ru'
        ? `Сообщение с сайта AFFLUX (Комментарии и пожелания)\nОт: ${name}${affiliation ? ', ' + affiliation : ''} <${from}>\n\n`
        : `Message from the AFFLUX site (Comments and suggestions)\nFrom: ${name}${affiliation ? ', ' + affiliation : ''} <${from}>\n\n`;
      return send(env, {
        to, subject: `[AFFLUX] ${subject || (lang === 'ru' ? 'Комментарии и пожелания' : 'Comments and suggestions')}`,
        text: head + text,
        headers: [{ name: 'Reply-To', value: from }]
      });
    },
    async sendAnnouncement({ to, subject, text, unsubscribeUrl, lang }) {
      const footer = lang === 'ru'
        ? `\n\n—\nВы получили это письмо, потому что включили анонсы в аккаунте AFFLUX. Отписаться: ${unsubscribeUrl}`
        : `\n\n—\nYou receive this because announcements are switched on in your AFFLUX account. Unsubscribe: ${unsubscribeUrl}`;
      return send(env, {
        to, subject, text: text + footer,
        headers: [
          { name: 'List-Unsubscribe', value: `<${unsubscribeUrl}>` },
          { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }
        ]
      });
    }
  };
}
