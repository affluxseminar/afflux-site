/* EEES — the site's editable texts.
   The texts a secretary may change without touching the code live in the content repository as
   data/site-texts.json, written by the admin's "Texts" page. The build merges that file over
   data/site.json (the defaults); only the fields listed here can be overridden, and every value
   is checked before it is used. Runs unchanged in Node (build.mjs) and in the Worker (admin). */

/* Plain strings under strings.<lang>.<key>, grouped as the editor shows them. */
export const TEXT_GROUPS = [
  { title: 'Masthead and footer', fields: [
    { key: 'subtitle', label: 'Subtitle under the wordmark', max: 200 },
    { key: 'description', label: 'Description for search engines and link previews', max: 400, rows: 3 },
    { key: 'footerRegister', label: 'Footer: about the announcements', max: 300, rows: 2 },
    { key: 'proposeTalk', label: 'About page, Contact: text before the address', max: 200 }
  ] },
  { title: 'Programme pages', fields: [
    { key: 'announcedShortly', label: 'Front page when no seminar is scheduled', max: 400, rows: 2 },
    { key: 'noUpcoming', label: 'Upcoming page when no seminar is scheduled', max: 400, rows: 2 },
    { key: 'archiveIntro', label: 'Archive: introduction', max: 400, rows: 2 },
    { key: 'archiveEmpty', label: 'Archive when it is empty', max: 300 },
    { key: 'joinOpenNote', label: 'Under the Zoom button', max: 300, rows: 2 },
    { key: 'joinLater', label: 'When there is no Zoom link yet', max: 300, rows: 2 }
  ] },
  { title: 'Subscribe page', fields: [
    { key: 'subscribeLead', label: 'Lead', max: 500, rows: 3 },
    { key: 'subscribeHow', label: 'How to subscribe', max: 800, rows: 4 },
    { key: 'subscribeNote', label: 'Note at the bottom', max: 800, rows: 4 },
    { key: 'registerCta', label: 'Link and button text: subscribe', max: 80 }
  ] }
];
export const TEXT_KEYS = TEXT_GROUPS.flatMap((g) => g.fields.map((f) => f.key));
export const LANGS = ['en', 'ru'];
export const LIMITS = { paragraph: 5000, paragraphs: 12, conveners: 4, name: 120, credential: 300, credentials: 12 };

const isStr = (v) => typeof v === 'string';
const plain = (s) => String(s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();

/* Checks a texts object; returns a list of problems (empty when it is fine). Unknown keys are reported,
   so a hand-edited file cannot silently do nothing. */
export function validateTexts(t) {
  const errors = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['the texts file must contain one object'];
  for (const k of Object.keys(t)) if (!['strings', 'about', 'conveners'].includes(k)) errors.push(`unknown section "${k}"`);
  if (t.strings != null) {
    if (typeof t.strings !== 'object' || Array.isArray(t.strings)) errors.push('"strings" must be an object with "en" and "ru"');
    else for (const lang of Object.keys(t.strings)) {
      if (!LANGS.includes(lang)) { errors.push(`strings: unknown language "${lang}"`); continue; }
      const o = t.strings[lang];
      if (!o || typeof o !== 'object' || Array.isArray(o)) { errors.push(`strings.${lang} must be an object`); continue; }
      for (const k of Object.keys(o)) {
        const f = TEXT_GROUPS.flatMap((g) => g.fields).find((x) => x.key === k);
        if (!f) { errors.push(`strings.${lang}.${k} is not an editable text`); continue; }
        if (!isStr(o[k])) errors.push(`strings.${lang}.${k} must be a string`);
        else if (o[k].length > f.max) errors.push(`strings.${lang}.${k} is longer than ${f.max} characters`);
      }
    }
  }
  if (t.about != null) {
    if (typeof t.about !== 'object' || Array.isArray(t.about)) errors.push('"about" must be an object with "en" and "ru"');
    else for (const lang of Object.keys(t.about)) {
      if (!LANGS.includes(lang)) { errors.push(`about: unknown language "${lang}"`); continue; }
      const a = t.about[lang];
      if (!Array.isArray(a)) { errors.push(`about.${lang} must be a list of paragraphs`); continue; }
      if (a.length > LIMITS.paragraphs) errors.push(`about.${lang}: more than ${LIMITS.paragraphs} paragraphs`);
      a.forEach((p, i) => { if (!isStr(p)) errors.push(`about.${lang}[${i}] must be a string`); else if (p.length > LIMITS.paragraph) errors.push(`about.${lang}[${i}] is longer than ${LIMITS.paragraph} characters`); });
    }
  }
  if (t.conveners != null) {
    if (!Array.isArray(t.conveners)) errors.push('"conveners" must be a list');
    else {
      if (t.conveners.length > LIMITS.conveners) errors.push(`more than ${LIMITS.conveners} conveners`);
      t.conveners.forEach((c, i) => {
        if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push(`conveners[${i}] must be an object`); return; }
        for (const k of Object.keys(c)) if (!['name', 'fullName', 'credentials'].includes(k)) errors.push(`conveners[${i}]: unknown field "${k}"`);
        for (const k of ['name', 'fullName']) {
          const v = c[k];
          if (v == null) { if (k === 'name') errors.push(`conveners[${i}]: "name" is required`); continue; }
          if (typeof v !== 'object' || Array.isArray(v)) { errors.push(`conveners[${i}].${k} must have "en" and "ru"`); continue; }
          for (const lang of Object.keys(v)) {
            if (!LANGS.includes(lang)) errors.push(`conveners[${i}].${k}: unknown language "${lang}"`);
            else if (!isStr(v[lang])) errors.push(`conveners[${i}].${k}.${lang} must be a string`);
            else if (v[lang].length > LIMITS.name) errors.push(`conveners[${i}].${k}.${lang} is longer than ${LIMITS.name} characters`);
          }
        }
        if (c.name && !LANGS.some((l) => isStr(c.name[l]) && c.name[l].trim())) errors.push(`conveners[${i}]: the name is empty`);
        if (c.credentials != null) {
          if (typeof c.credentials !== 'object' || Array.isArray(c.credentials)) { errors.push(`conveners[${i}].credentials must have "en" and "ru" lists`); }
          else for (const lang of Object.keys(c.credentials)) {
            const lines = c.credentials[lang];
            if (!LANGS.includes(lang)) { errors.push(`conveners[${i}].credentials: unknown language "${lang}"`); continue; }
            if (!Array.isArray(lines)) { errors.push(`conveners[${i}].credentials.${lang} must be a list of lines`); continue; }
            if (lines.length > LIMITS.credentials) errors.push(`conveners[${i}].credentials.${lang}: more than ${LIMITS.credentials} lines`);
            lines.forEach((l, j) => { if (!isStr(l)) errors.push(`conveners[${i}].credentials.${lang}[${j}] must be a string`); else if (l.length > LIMITS.credential) errors.push(`conveners[${i}].credentials.${lang}[${j}] is longer than ${LIMITS.credential} characters`); });
          }
        }
      });
    }
  }
  return errors;
}

/* The site record with the texts applied. Empty strings and empty lists mean "keep the default". */
export function applyTexts(site, t) {
  if (!t) return site;
  const out = { ...site, strings: { ...site.strings }, about: { ...(site.about || {}) } };
  for (const lang of LANGS) {
    const o = t.strings && t.strings[lang];
    if (o) {
      const s = { ...out.strings[lang] };
      for (const k of TEXT_KEYS) if (isStr(o[k]) && plain(o[k])) s[k] = plain(o[k]);
      out.strings[lang] = s;
    }
    const a = t.about && t.about[lang];
    if (Array.isArray(a)) {
      const ps = a.map(plain).filter(Boolean);
      if (ps.length) out.about[lang] = ps;
    }
  }
  if (Array.isArray(t.conveners)) {
    const cs = t.conveners.map((c) => {
      const pick = (v) => { const r = {}; for (const l of LANGS) if (v && isStr(v[l]) && plain(v[l])) r[l] = plain(v[l]); return r; };
      const name = pick(c.name), fullName = pick(c.fullName);
      const credentials = {};
      for (const l of LANGS) { const lines = (c.credentials && c.credentials[l] || []).map(plain).filter(Boolean); if (lines.length) credentials[l] = lines; }
      if (!Object.keys(name).length) return null;
      const r = { name };
      if (Object.keys(fullName).length) r.fullName = fullName;
      if (Object.keys(credentials).length) r.credentials = credentials;
      return r;
    }).filter(Boolean);
    if (cs.length) out.conveners = cs;
  }
  return out;
}

/* The editable texts as they currently stand (defaults with the overrides applied), in the file's own
   shape — what the editor shows, and what it writes back in full. */
export function textsOf(site) {
  const strings = {}, about = {};
  for (const lang of LANGS) {
    strings[lang] = {};
    for (const k of TEXT_KEYS) strings[lang][k] = (site.strings[lang] && site.strings[lang][k]) || '';
    about[lang] = (site.about && site.about[lang]) || [];
  }
  const conveners = (site.conveners || []).map((c) => ({
    name: { en: (c.name && c.name.en) || '', ru: (c.name && c.name.ru) || '' },
    fullName: { en: (c.fullName && c.fullName.en) || '', ru: (c.fullName && c.fullName.ru) || '' },
    credentials: { en: (c.credentials && c.credentials.en) || [], ru: (c.credentials && c.credentials.ru) || [] }
  }));
  return { strings, about, conveners };
}
