/* AFFLUX — shared templates.
   Runs unchanged in Node (build.mjs) and in the browser (preview router).
   Pure functions: (data, context) -> HTML strings. No DOM access here. */
(function (root) {
  'use strict';

  /* ---------- small helpers ---------- */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* Russian typography: a preposition or conjunction never ends a line, a dash never starts one,
     a number keeps its unit. Applied to every Russian text at render time, so editors type plain
     spaces and the site sets them. Non-breaking spaces are what a typesetter would put there. */
  const NB = '\u00A0';
  const RU_SHORT = /(?<![^\s(«„"'])(и|а|но|в|во|на|с|со|к|ко|о|об|от|до|за|из|по|не|ни|у|же|ли|бы|под|над|при|для|без|про|то|что|как|или)\s+(?=[а-яёa-z0-9«"(])/gi;
  function typo(text) {
    if (typeof text !== 'string' || !/[а-яё]/i.test(text)) return text;
    return text
      .replace(RU_SHORT, (m, w) => `${w}${NB}`)
      .replace(/\s+(—|–)(?=\s)/g, `${NB}$1`)                           // "слово — слово"
      .replace(/(\d)\s+(года|году|год|г\.|ч\.|ч|мин|%|тыс|млн)(?=[\s.,;:)]|$)/g, `$1${NB}$2`)
      .replace(/([А-ЯЁ])\.\s+([А-ЯЁ])\.\s+([А-ЯЁ])/g, `$1.${NB}$2.${NB}$3`);   // initials: В. М. Полтерович
  }
  const typoDeep = (v) => (typeof v === 'string' ? typo(v) : Array.isArray(v) ? v.map(typoDeep) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typoDeep(x)])) : v);
  const typoCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  // The site record with its Russian strings, About text and credentials typeset. Memoized per site object.
  function typoSite(site) {
    if (typoCache && typoCache.has(site)) return typoCache.get(site);
    const out = Object.assign({}, site, {
      strings: Object.assign({}, site.strings, { ru: typoDeep(site.strings.ru) }),
      about: site.about ? Object.assign({}, site.about, { ru: typoDeep(site.about.ru) }) : site.about,
      conveners: (site.conveners || []).map((c) => typoDeep(c))
    });
    if (typoCache) typoCache.set(site, out);
    return out;
  }

  // A field may be a plain string or {en, ru}. Returns {text, lang}; lang is set
  // only when we had to fall back to the other language (so the markup can carry lang="").
  function lf(v, lang) {
    if (v == null) return { text: '', lang: null };
    if (typeof v === 'string') return { text: typo(v), lang: null };
    if (v[lang]) return { text: typo(v[lang]), lang: null };
    const other = lang === 'en' ? 'ru' : 'en';
    return { text: typo(v[other] || ''), lang: v[other] ? other : null };
  }
  const L = (v, lang) => lf(v, lang).text;

  const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : vars[k]));

  const paras = (text, lang) => typo(String(text || ''))
    .split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p${lang ? ` lang="${lang}"` : ''}>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');

  // First paragraph of a text, cut at a sentence end near `limit` characters.
  function synopsis(text, limit) {
    const first = String(text || '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
    if (first.length <= limit) return first;
    const cut = first.slice(0, limit);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (end > limit * 0.5) return cut.slice(0, end + 1);
    return cut.slice(0, cut.lastIndexOf(' ')) + '…';
  }

  const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('');

  /* ---------- time ---------- */

  function tzOffsetMinutes(dateUtc, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = {};
    dtf.formatToParts(dateUtc).forEach((x) => { p[x.type] = x.value; });
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return (asUtc - dateUtc.getTime()) / 60000;
  }

  // Local wall-clock (date "YYYY-MM-DD", time "HH:MM") in tz -> Date (UTC instant)
  function toUtc(date, time, tz) {
    const guess = new Date(`${date}T${time || '00:00'}:00Z`);
    let off = tzOffsetMinutes(guess, tz);
    let utc = new Date(guess.getTime() - off * 60000);
    const off2 = tzOffsetMinutes(utc, tz);
    if (off2 !== off) utc = new Date(guess.getTime() - off2 * 60000);
    return utc;
  }

  const locale = (lang) => (lang === 'ru' ? 'ru-RU' : 'en-GB');

  function fmtLongDate(d, lang, tz) {
    return new Intl.DateTimeFormat(locale(lang), {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz
    }).format(d).replace(/ г\.$/, '');
  }
  function fmtDayMonth(d, lang, tz) {
    return new Intl.DateTimeFormat(locale(lang), { day: 'numeric', month: 'long', timeZone: tz })
      .format(d);
  }
  function fmtShortDate(d, lang, tz) {
    return new Intl.DateTimeFormat(locale(lang), { day: 'numeric', month: 'short', timeZone: tz })
      .format(d).replace(/\.$/, '');
  }
  function fmtTime(d, tz) {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
      .format(d);
  }
  function fmtYear(d, tz) {
    return new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: tz }).format(d);
  }

  /* ---------- talk model ---------- */

  function prepare(site, talks, now) {
    const tz = site.defaultTimezone;
    const dur = site.defaultDurationMinutes || 90;
    const list = (talks || []).map((t) => {
      const timezone = t.timezone || tz;
      const start = toUtc(t.date, t.time, timezone);
      const end = new Date(start.getTime() + (t.duration || dur) * 60000);
      let status = 'upcoming';
      if (now >= end) status = 'past';
      else if (now >= start) status = 'live';
      return Object.assign({}, t, { timezone, start, end, status });
    });
    list.sort((a, b) => b.start - a.start);            // newest first
    const upcoming = list.filter((t) => t.status !== 'past').sort((a, b) => a.start - b.start);
    const past = list.filter((t) => t.status === 'past');
    return { all: list, upcoming, past, next: upcoming[0] || null };
  }

  /* ---------- URL helpers ---------- */

  // ctx.url(lang, path) is provided by the environment:
  //   build:   ('ru', '/archive/') -> '/ru/archive/'
  //   preview: ('ru', '/archive/') -> '#/ru/archive/'
  const talkPath = (t) => `/talks/${t.slug}/`;
  // A document link (slides, minutes) is either an https address or the name of a file in files/.
  const fileUrl = (site, v) => (/^https?:\/\//.test(v) ? v : (site.fileBase || '/files/') + String(v).replace(/^\/?files\//, ''));

  /* ---------- chrome: header & footer ---------- */

  function header(ctx, page) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    const other = lang === 'en' ? 'ru' : 'en';
    const nav = ['upcoming', 'archive', 'about', 'subscribe'].map((k) => {
      const cur = page.kind === k ? ' aria-current="page"' : '';
      return `<a href="${ctx.url(lang, `/${k}/`)}"${cur}>${esc(s.nav[k])}</a>`;
    }).join('');
    const samePath = page.path; // language-neutral path of this page
    return `<header class="site-head${page.kind === 'home' ? ' is-home' : ''}" id="top">
  <div class="wrap head-grid">
    <a class="brand" href="${ctx.url(lang, '/')}"><span class="brand-mark">AFFLUX</span><span class="brand-sub">${esc(s.subtitle)}</span></a>
    <nav class="site-nav" aria-label="${esc(s.navLabel)}">${nav}</nav>
    <fieldset class="theme" data-theme-control>
      <legend class="vh">${esc(s.appearance)}</legend>
      ${['light', 'dark', 'deep'].map((k) => `<label title="${esc(s.theme[k])}"><input type="radio" name="theme" value="${k}"><span class="sw sw-${k}"></span><span class="vh">${esc(s.theme[k])}</span></label>`).join('')}
    </fieldset>
    <div class="lang" aria-label="${esc(s.langSwitch)}">
      <a href="${ctx.url('en', samePath)}" lang="en" hreflang="en"${lang === 'en' ? ' aria-current="true"' : ''}>EN</a><span aria-hidden="true">/</span><a href="${ctx.url('ru', samePath)}" lang="ru" hreflang="ru"${lang === 'ru' ? ' aria-current="true"' : ''}>RU</a>
    </div>
  </div>
</header>`;
  }

  function convenersText(ctx) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    const names = site.conveners.map((c) => L(c.name, lang));
    const joined = names.length > 1
      ? names.slice(0, -1).join(', ') + ` ${s.and}\u00A0` + names[names.length - 1]   // the conjunction never ends a line
      : names[0] || '';
    return fill(s.convenedBy, { names: joined });
  }

  function footer(ctx) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    return `<footer class="site-foot">
  <div class="wrap foot-grid">
    <div class="foot-brand">
      <span class="brand-mark">AFFLUX</span>
      <p>${esc(s.subtitle)}<br>${esc(convenersText(ctx))}${s.since ? `<br>${esc(s.since)}` : ''}</p>
    </div>
    <div class="foot-col">
      <p>${esc(s.contact)}<br><a href="mailto:${esc(site.email)}">${esc(site.email)}</a></p>
    </div>
    <div class="foot-col">
      <p>${esc(s.footerRegister)}<br><a href="${ctx.url(lang, '/subscribe/')}">${esc(s.registerCta)}</a></p>
    </div>
  </div>
</footer>`;
  }

  /* ---------- pieces ---------- */

  function whenBlock(t, ctx, opts) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    const big = opts && opts.big;
    const iso = t.start.toISOString();
    const date = fmtLongDate(t.start, lang, t.timezone);
    const time = fmtTime(t.start, t.timezone);
    const tzNote = t.timezone === 'Europe/Moscow' ? s.moscowTime : `(${t.timezone})`;
    return `<p class="when${big ? ' when-big' : ''}">
  <time datetime="${iso}">${esc(date)}</time>
  <span class="when-time">${esc(time)} ${esc(tzNote)}</span>
  <span class="when-local" data-start="${iso}" data-tz="${esc(t.timezone)}" data-lang="${lang}" data-tpl="${esc(s.localTime)}" hidden></span>
</p>`;
  }

  function speakerLine(t, ctx, tag) {
    const { lang } = ctx;
    const sp = lf(t.speaker, lang);
    const af = lf(t.affiliation, lang);
    const T = tag || 'p';
    return `<${T} class="who"><span class="who-name"${sp.lang ? ` lang="${sp.lang}"` : ''}>${esc(sp.text)}</span>${af.text ? `<span class="who-aff"${af.lang ? ` lang="${af.lang}"` : ''}>${esc(af.text)}</span>` : ''}</${T}>`;
  }

  function portrait(t, ctx) {
    const { lang, site } = ctx;
    const name = L(t.speaker, lang);
    if (t.photo) {
      const src = /^https?:\/\//.test(t.photo) ? t.photo : (site.photoBase || '/photos/') + t.photo;
      return `<figure class="portrait"><img src="${esc(src)}" alt="${esc(name)}" width="480" height="600" loading="lazy" decoding="async"></figure>`;
    }
    return `<figure class="portrait portrait-plate" aria-hidden="true"><span>${esc(initials(name))}</span></figure>`;
  }

  function actions(t, ctx, opts) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    const full = opts && opts.full;
    const out = [];
    if (t.status !== 'past') {
      if (t.zoom) out.push(`<a class="btn" href="${esc(t.zoom)}" rel="noopener" data-join>${esc(t.status === 'live' ? s.live : s.join)}</a>`);
      if (full) out.push(`<span class="note">${esc(t.zoom ? s.joinOpenNote : s.joinLater)}</span>`);
    } else {
      if (t.video) out.push(`<a class="btn" href="${esc(t.video)}" rel="noopener">${esc(s.recording)}</a>`);
      if (t.slides) out.push(`<a class="btn btn-quiet" href="${esc(fileUrl(site, t.slides))}">${esc(s.slides)}</a>`);
      if (t.minutes) out.push(`<a class="btn btn-quiet" href="${esc(fileUrl(site, t.minutes))}">${esc(s.minutes)}</a>`);
      if (full && !t.video) out.push(`<span class="note">${esc(s.noRecording)}</span>`);
    }
    if (!full) out.push(`<a class="more" href="${ctx.url(lang, talkPath(t))}">${esc(s.details)}</a>`);
    return `<p class="actions" data-talk-start="${t.start.toISOString()}" data-talk-end="${t.end.toISOString()}" data-soon="${esc(s.recordingSoon)}" data-live="${esc(s.live)}">${out.join('\n  ')}</p>`;
  }

  function ledger(items, ctx, opts) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    const mode = (opts && opts.mode) || 'past';
    const rows = items.map((t) => {
      const title = lf(t.title, lang);
      const sp = lf(t.speaker, lang);
      const af = lf(t.affiliation, lang);
      const dateTxt = fmtDayMonth(t.start, lang, t.timezone);
      let links = '';
      if (mode === 'past') {
        const parts = [];
        if (t.video) parts.push(`<a href="${esc(t.video)}" rel="noopener">${esc(s.recordingShort)}</a>`);
        if (t.slides) parts.push(`<a href="${esc(fileUrl(site, t.slides))}">${esc(s.slidesShort)}</a>`);
        if (t.minutes) parts.push(`<a href="${esc(fileUrl(site, t.minutes))}">${esc(s.minutesShort)}</a>`);
        links = parts.join('');
      } else {
        links = `<span class="row-time">${esc(fmtTime(t.start, t.timezone))}</span>`;
      }
      return `<li class="row">
  <time class="row-date" datetime="${t.start.toISOString()}">${esc(dateTxt)}</time>
  <span class="row-who"><span${sp.lang ? ` lang="${sp.lang}"` : ''}>${esc(sp.text)}</span>${af.text ? `<span class="row-aff"${af.lang ? ` lang="${af.lang}"` : ''}>${esc(af.text)}</span>` : ''}</span>
  <a class="row-title" href="${ctx.url(lang, talkPath(t))}"${title.lang ? ` lang="${title.lang}"` : ''}>${esc(title.text)}</a>
  <span class="row-lang" title="${esc(s.talkIn[t.language] || '')}">${esc(s.langCode[t.language] || t.language)}</span>
  <span class="row-links">${links}</span>
</li>`;
    }).join('\n');
    return `<ol class="ledger ledger-${mode}">\n${rows}\n</ol>`;
  }

  /* ---------- pages ---------- */

  function home(ctx, model) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    const n = model.next;
    let nextHtml;
    if (n) {
      const title = lf(n.title, lang);
      const syn = n.summary ? lf(n.summary, lang) : (() => { const a = lf(n.abstract, lang); return { text: synopsis(a.text, 300), lang: a.lang }; })();
      nextHtml = `<div class="next-main">
  ${whenBlock(n, ctx, { big: true })}
  <h3 class="next-title${title.text.length > 80 ? ' is-long' : ''}"><a href="${ctx.url(lang, talkPath(n))}"${title.lang ? ` lang="${title.lang}"` : ''}>${esc(title.text)}</a></h3>
  ${speakerLine(n, ctx)}
  <p class="meta">${esc(s.talkIn[n.language] || '')}. ${esc(fill(s.seminarNo, { n: n.number }))}.</p>
  ${syn.text ? `<p class="synopsis"${syn.lang ? ` lang="${syn.lang}"` : ''}>${esc(syn.text)}</p>` : ''}
  ${actions(n, ctx)}
</div>`;
    } else {
      nextHtml = `<div class="next-main">
  <h3 class="empty-title">${esc(s.programmeForthcoming)}</h3>
  <p class="lede">${esc(s.announcedShortly)}</p>
  <p class="actions"><a class="btn" href="${ctx.url(lang, '/subscribe/')}">${esc(s.registerCta)}</a></p>
</div>`;
    }
    const following = model.upcoming.slice(1, 4);
    const recent = model.past.filter((t) => t.video).slice(0, 4);

    return `<section class="mast" aria-label="AFFLUX">
  <h1 class="wordmark" aria-label="AFFLUX"><span aria-hidden="true">A</span><span aria-hidden="true">F</span><span aria-hidden="true">F</span><span aria-hidden="true">L</span><span aria-hidden="true">U</span><span aria-hidden="true">X</span></h1>
  <p class="mast-sub"><span>${esc(s.subtitle)}</span><span>${esc(convenersText(ctx))}</span>${s.since ? `<span class="mast-since">${esc(s.since)}</span>` : ''}</p>
</section>

<section class="sec next">
  <h2 class="sec-label">${esc(s.nextSeminar)}</h2>
  <div class="sec-body next-grid">
    ${nextHtml}
    <figure class="field" aria-hidden="true"${ctx.fieldAttrs || ''}>
      ${ctx.fieldSvg || ''}
      <figcaption>${s.fieldCaptionHtml || esc(s.fieldCaption)}</figcaption>
    </figure>
  </div>
</section>
${following.length ? `
<section class="sec">
  <h2 class="sec-label">${esc(s.following)}</h2>
  <div class="sec-body">${ledger(following, ctx, { mode: 'upcoming' })}</div>
</section>` : ''}
${recent.length ? `
<section class="sec">
  <h2 class="sec-label">${esc(s.recentRecordings)}</h2>
  <div class="sec-body">
    ${ledger(recent, ctx, { mode: 'past' })}
    <p class="sec-more"><a href="${ctx.url(lang, '/archive/')}">${esc(s.allRecordings)}</a></p>
  </div>
</section>` : ''}
<section class="sec">
  <h2 class="sec-label">${esc(s.aboutShort)}</h2>
  <div class="sec-body prose">
    <p>${esc(((site.about && (site.about[lang] || site.about.en)) || [])[0] || '')}</p>
    <p class="sec-more"><a href="${ctx.url(lang, '/about/')}">${esc(s.readMore)}</a></p>
  </div>
</section>`;
  }

  function upcomingPage(ctx, model) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    const n = model.next;
    let lead = '';
    if (n) {
      const title = lf(n.title, lang);
      lead = `<section class="sec next">
  <h2 class="sec-label">${esc(s.nextSeminar)}</h2>
  <div class="sec-body">
    <div class="next-main">
      ${whenBlock(n, ctx, { big: true })}
      <h3 class="next-title${title.text.length > 80 ? ' is-long' : ''}"><a href="${ctx.url(lang, talkPath(n))}"${title.lang ? ` lang="${title.lang}"` : ''}>${esc(title.text)}</a></h3>
      ${speakerLine(n, ctx)}
      <p class="meta">${esc(s.talkIn[n.language] || '')}. ${esc(fill(s.seminarNo, { n: n.number }))}.</p>
      ${actions(n, ctx)}
    </div>
  </div>
</section>`;
    }
    const rest = model.upcoming.slice(1);
    return `<section class="page-head">
  <h1 class="page-title">${esc(s.upcomingTitle)}</h1>
</section>
${n ? lead : `<section class="sec">
  <div class="sec-label"></div>
  <div class="sec-body">
    <h2 class="empty-title">${esc(s.programmeForthcoming)}</h2>
    <p class="lede">${esc(s.announcedShortly)}</p>
    <p class="actions"><a class="btn" href="${ctx.url(lang, '/subscribe/')}">${esc(s.registerCta)}</a></p>
  </div>
</section>`}
${rest.length ? `<section class="sec">
  <h2 class="sec-label">${esc(s.following)}</h2>
  <div class="sec-body">${ledger(rest, ctx, { mode: 'upcoming' })}</div>
</section>` : ''}`;
  }

  function archivePage(ctx, model) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    // group by year (in the talk's own time zone)
    const groups = new Map();
    model.past.forEach((t) => {
      const y = fmtYear(t.start, t.timezone);
      if (!groups.has(y)) groups.set(y, []);
      groups.get(y).push(t);
    });
    const sections = [...groups.entries()].map(([year, items]) => `<section class="sec">
  <h2 class="sec-label">${esc(year)}</h2>
  <div class="sec-body">${ledger(items, ctx, { mode: 'past' })}</div>
</section>`).join('\n');
    return `<section class="page-head">
  <h1 class="page-title">${esc(s.archiveTitle)}</h1>
  <p class="lede">${esc(s.archiveIntro)}</p>
</section>
${sections || `<section class="sec">
  <div class="sec-label"></div>
  <div class="sec-body prose"><p>${esc(s.archiveEmpty)}</p></div>
</section>`}`;
  }

  function aboutPage(ctx, model) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    const text = (site.about && (site.about[lang] || site.about.en)) || [];
    const conveners = site.conveners.map((c) => {
      const name = L(c.fullName || c.name, lang);
      const lines = (c.credentials && (c.credentials[lang] || c.credentials.en)) || (c.affiliation ? [L(c.affiliation, lang)] : []);
      return `<li><span class="who-name">${esc(name)}</span>${lines.map((l) => `<span class="who-aff">${esc(l)}</span>`).join('')}</li>`;
    }).join('');
    return `<section class="page-head">
  <h1 class="page-title">${esc(s.aboutTitle)}</h1>
</section>
<section class="sec">
  <div class="sec-label"></div>
  <div class="sec-body prose">${text.map((p) => `<p>${esc(p)}</p>`).join('\n')}</div>
</section>
<section class="sec">
  <h2 class="sec-label">${esc(s.conveners)}</h2>
  <div class="sec-body"><ul class="people">${conveners}</ul></div>
</section>
<section class="sec">
  <h2 class="sec-label">${esc(s.contact)}</h2>
  <div class="sec-body prose"><p>${esc(s.proposeTalk)} <a href="mailto:${esc(site.email)}">${esc(site.email)}</a>.</p></div>
</section>`;
  }

  function subscribePage(ctx) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    const mail = `mailto:${site.email}?subject=${encodeURIComponent(s.subscribeSubject)}`;
    return `<section class="page-head">
  <h1 class="page-title">${esc(s.subscribeTitle)}</h1>
  <p class="lede">${esc(s.subscribeLead)}</p>
</section>
<section class="sec">
  <div class="sec-label"></div>
  <div class="sec-body prose">
    <p>${esc(s.subscribeHow)}</p>
    <p class="actions"><a class="btn" href="${esc(mail)}">${esc(s.subscribeButton)}</a><a class="more" href="mailto:${esc(site.email)}">${esc(site.email)}</a></p>
    <p class="note">${esc(s.subscribeNote)}</p>
  </div>
</section>`;
  }

  function talkPage(ctx, t) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    const title = lf(t.title, lang);
    const abs = lf(t.abstract, lang);
    const bio = lf(t.bio, lang);
    return `<article class="talk">
  <header class="sec talk-head">
    <div class="sec-label talk-meta">
      <p>${esc(fill(s.seminarNo, { n: t.number }))}</p>
      ${whenBlock(t, ctx)}
      <p>${esc(s.talkIn[t.language] || '')}</p>
    </div>
    <div class="sec-body">
      <h1 class="talk-title${title.text.length > 80 ? ' is-long' : ''}"${title.lang ? ` lang="${title.lang}"` : ''}>${esc(title.text)}</h1>
      ${speakerLine(t, ctx)}
      ${actions(t, ctx, { full: true })}
    </div>
  </header>
  <div class="sec">
    <div class="sec-label">${portrait(t, ctx)}</div>
    <div class="sec-body prose talk-body">
      ${abs.text ? `<h2>${esc(s.abstract)}</h2>\n${paras(abs.text, abs.lang)}` : ''}
      ${bio.text ? `<h2>${esc(s.bio)}</h2>\n${paras(bio.text, bio.lang)}` : ''}
    </div>
  </div>
</article>`;
  }

  function notFoundPage(ctx) {
    const { lang, site } = ctx;
    const s = site.strings[lang];
    return `<section class="page-head">
  <h1 class="page-title">${esc(s.notFound)}</h1>
  <p class="lede">${esc(s.notFoundText)}</p>
  <p><a href="${ctx.url(lang, '/')}">${esc(s.toHome)}</a></p>
</section>`;
  }

  /* ---------- routing ---------- */

  // path is language-neutral: '/', '/upcoming/', '/archive/', '/about/', '/subscribe/', '/talks/<slug>/'
  function parsePath(raw) {
    let p = String(raw || '/').replace(/^#/, '');
    if (!p.startsWith('/')) p = '/' + p;
    let lang = 'en';
    if (p === '/ru' || p.startsWith('/ru/')) { lang = 'ru'; p = p.slice(3) || '/'; }
    if (!p.endsWith('/')) p += '/';
    if (p === '/') return { lang, kind: 'home', path: '/' };
    const m = p.match(/^\/(upcoming|archive|about|subscribe)\/$/);
    if (m) return { lang, kind: m[1], path: p };
    const tm = p.match(/^\/talks\/([A-Za-z0-9._-]+)\/$/);
    if (tm) return { lang, kind: 'talk', slug: tm[1], path: p };
    return { lang, kind: '404', path: p };
  }

  // Returns {title, description, main, lang, kind, path, talk?, ogType}
  function renderRoute(route, ctx, model) {
    const site = typoSite(ctx.site);
    const lang = route.lang;
    const s = site.strings[lang];
    const c = Object.assign({}, ctx, { lang, site });
    const base = `AFFLUX`;
    let title, description, main, talk = null;
    switch (route.kind) {
      case 'home':
        title = `${base}: ${s.subtitle}`;
        description = s.description;
        main = home(c, model);
        break;
      case 'upcoming':
        title = `${s.upcomingTitle}, ${base}`;
        description = s.description;
        main = upcomingPage(c, model);
        break;
      case 'archive':
        title = `${s.archiveTitle}, ${base}`;
        description = s.archiveIntro;
        main = archivePage(c, model);
        break;
      case 'about':
        title = `${s.aboutTitle}, ${base}`;
        description = s.description;
        main = aboutPage(c, model);
        break;
      case 'subscribe':
        title = `${s.subscribeTitle}, ${base}`;
        description = s.subscribeLead;
        main = subscribePage(c);
        break;
      case 'talk': {
        talk = model.all.find((t) => t.slug === route.slug) || null;
        if (!talk) { title = `${s.notFound}, ${base}`; description = s.notFoundText; main = notFoundPage(c); route = Object.assign({}, route, { kind: '404' }); break; }
        const tt = L(talk.title, lang);
        const sp = L(talk.speaker, lang);
        title = `${tt}, ${sp}, ${base}`;
        description = `${fmtLongDate(talk.start, lang, talk.timezone)}, ${fmtTime(talk.start, talk.timezone)}. ${sp}${talk.affiliation ? ', ' + L(talk.affiliation, lang) : ''}. ${s.talkIn[talk.language] || ''}.`;
        main = talkPage(c, talk);
        break;
      }
      default:
        title = `${s.notFound}, ${base}`;
        description = s.notFoundText;
        main = notFoundPage(c);
    }
    return { title, description, main, lang, kind: route.kind, path: route.path, talk, header: header(c, route), footer: footer(c) };
  }

  root.AFFLUX = {
    esc, lf, L, fill, paras, synopsis, typo, typoSite, toUtc, tzOffsetMinutes, fmtLongDate, fmtTime, fmtYear,
    prepare, parsePath, renderRoute, talkPath, header, footer
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
