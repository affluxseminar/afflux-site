/* AFFLUX — client enhancements. The site works without this file;
   with it: local time, live status, header state, the appearance control. */
(function () {
  'use strict';

  var THEMES = ['light', 'dark', 'deep'];
  var KEY = 'afflux-theme';
  var THEME_COLOR = { light: '#E2E5DF', dark: '#121C29', deep: '#070E1A' };

  /* ---------- appearance ---------- */

  function storedTheme() {
    try { var t = localStorage.getItem(KEY); return THEMES.indexOf(t) >= 0 ? t : null; } catch (e) { return null; }
  }
  // What the page is actually showing right now.
  function currentTheme() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (THEMES.indexOf(attr) >= 0) return attr;
    var light = false;
    try { light = window.matchMedia('(prefers-color-scheme: light)').matches; } catch (e) {}
    return light ? 'light' : 'deep';
  }
  function syncControls(t) {
    var all = document.querySelectorAll('[data-theme-control] input');
    for (var i = 0; i < all.length; i++) all[i].checked = all[i].value === t;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[t]);
  }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(KEY, t); } catch (e) {}
    syncControls(t);
  }
  function themeControl(rootEl) {
    var inputs = rootEl.querySelectorAll('[data-theme-control] input[type="radio"]');
    if (!inputs.length) return;
    syncControls(currentTheme());
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('change', function (ev) {
        if (ev.target.checked) applyTheme(ev.target.value);
      });
    }
  }
  // Follow the system until the visitor has chosen; stop once they have.
  function followSystem() {
    try {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var onChange = function () {
        if (storedTheme()) return;
        document.documentElement.removeAttribute('data-theme');
        syncControls(currentTheme());
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    } catch (e) {}
  }

  /* ---------- time ---------- */

  function localTimes(rootEl) {
    var viewerTz;
    try { viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return; }
    var els = rootEl.querySelectorAll('.when-local[data-start]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var talkTz = el.getAttribute('data-tz');
      if (!viewerTz || viewerTz === talkTz) continue;
      var d = new Date(el.getAttribute('data-start'));
      if (isNaN(d)) continue;
      var lang = el.getAttribute('data-lang') || 'en';
      var loc = lang === 'ru' ? 'ru-RU' : 'en-GB';
      var time;
      try {
        time = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: viewerTz }).format(d);
        var dayHere = new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: viewerTz }).format(d);
        var dayThere = new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: talkTz }).format(d);
        if (dayHere !== dayThere) {
          time += ', ' + new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', timeZone: viewerTz }).format(d);
        }
      } catch (e) { continue; }
      var tpl = el.getAttribute('data-tpl') || '{time}';
      el.textContent = tpl.replace('{time}', time);
      el.hidden = false;
    }
  }

  function liveStatus(rootEl) {
    var now = Date.now();
    var blocks = rootEl.querySelectorAll('.actions[data-talk-start]');
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var start = Date.parse(b.getAttribute('data-talk-start'));
      var end = Date.parse(b.getAttribute('data-talk-end'));
      var join = b.querySelector('[data-join]');
      if (!join) continue;
      if (now > end) {
        var note = document.createElement('span');
        note.className = 'note';
        note.textContent = b.getAttribute('data-soon') || '';
        join.replaceWith(note);
      } else if (now >= start) {
        join.textContent = b.getAttribute('data-live') || join.textContent;
      }
    }
  }

  /* ---------- chrome ---------- */

  function headerState() {
    var head = document.querySelector('.site-head');
    if (!head) return;
    var onScroll = function () { head.classList.toggle('is-stuck', window.scrollY > 4); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    var mast = document.querySelector('.mast');
    if (mast && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        head.classList.toggle('show-brand', !entries[0].isIntersecting);
      }, { rootMargin: '-56px 0px 0px 0px', threshold: 0 });
      io.observe(mast);
    } else {
      head.classList.add('show-brand');
    }
  }

  /* The static site cannot know whether a visitor is signed in; a flag cookie set alongside the
     session (no secret in it) lets the menu say "Account" instead of "Register". */
  function accountNav(rootEl) {
    if (!/(^|; )afflux_in=1(;|$)/.test(document.cookie)) return;
    var links = rootEl.querySelectorAll('a[data-nav-account]');
    for (var i = 0; i < links.length; i++) {
      links[i].textContent = links[i].getAttribute('data-nav-account');
      links[i].setAttribute('href', links[i].getAttribute('data-href-account'));
    }
  }

  /* Admin progress pages: a form marked data-autosubmit is submitted again after a short pause,
     so a long send proceeds in POST steps while the page stays open. */
  function autoSubmit(rootEl) {
    var f = rootEl.querySelector('form[data-autosubmit]');
    if (!f) return;
    setTimeout(function () { if (f.isConnected) f.submit(); }, Number(f.getAttribute('data-autosubmit')) || 1000);
  }

  /* Destructive forms (delete account, delete talk) ask once before submitting. */
  function confirmForms(rootEl) {
    var forms = rootEl.querySelectorAll('form[data-confirm]');
    for (var i = 0; i < forms.length; i++) {
      forms[i].addEventListener('submit', function (e) { if (!window.confirm(this.getAttribute('data-confirm'))) e.preventDefault(); });
    }
  }

  function init(rootEl) {
    rootEl = rootEl || document;
    accountNav(rootEl);
    autoSubmit(rootEl);
    confirmForms(rootEl);
    themeControl(rootEl);
    localTimes(rootEl);
    liveStatus(rootEl);
  }

  window.AFFLUX_CLIENT = { init: init, headerState: headerState };

  followSystem();
  if (!document.documentElement.hasAttribute('data-preview')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(); headerState(); });
    } else { init(); headerState(); }
  }
})();
