/* EEES — the live field. Tracer particles advected through the same vector field as Fig. 1,
   drawn on a canvas over the printed streamlines. Optional: the page is complete without it.
   Modes: "sink" (default, a flowing towards), "source" (the reversed field: a letter leaving),
   and a one-off "gather" on form submit. Off under prefers-reduced-motion. */
(function () {
  'use strict';
  if (!('requestAnimationFrame' in window)) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  var registry = window.AFFLUX_FIELD || (window.AFFLUX_FIELD = { instances: [] });
  for (var r = 0; r < registry.instances.length; r++) { try { registry.instances[r].destroy(); } catch (e) {} }
  registry.instances = [];

  function start(fig) {
    var p;
    try { p = JSON.parse(fig.getAttribute('data-field')); } catch (e) { return; }
    var svg = fig.querySelector('svg');
    if (!svg) return;
    var mode = fig.getAttribute('data-mode') || 'sink';
    var canvas = document.createElement('canvas');
    canvas.className = 'field-live';
    canvas.setAttribute('aria-hidden', 'true');
    svg.insertAdjacentElement('afterend', canvas);
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = p.w, H = p.h, scale = 1;
    var particles = [], N = 0;
    var colours = { field: '#5e7278', accent: '#4fcdb4' };
    var t0 = performance.now(), last = t0, running = false, visible = true, gatherUntil = 0;

    function readColours() {
      var cs = getComputedStyle(fig);
      colours.field = cs.getPropertyValue('--field').trim() || colours.field;
      colours.accent = cs.getPropertyValue('--accent').trim() || colours.accent;
    }
    function resize() {
      var rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      scale = rect.width / W;
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      N = rect.width < 380 ? 110 : 220;
      while (particles.length < N) particles.push(seed(true));
      particles.length = N;
    }
    function seed(anywhere) {
      var q;
      if (mode === 'source') {
        var a = Math.random() * Math.PI * 2, r = 5 + Math.random() * 6;
        q = { x: p.sink[0] + Math.cos(a) * r, y: p.sink[1] + Math.sin(a) * r };
      } else if (anywhere) {
        q = { x: Math.random() * W, y: Math.random() * H };
      } else {
        var s = Math.random() * (2 * W + 2 * H);
        if (s < H) q = { x: 0, y: s };
        else if (s < H + W) q = { x: s - H, y: 0 };
        else if (s < 2 * H + W) q = { x: W, y: s - H - W };
        else q = { x: s - 2 * H - W, y: H };
      }
      q.px = q.x; q.py = q.y; q.lum = Math.random() < 0.14; q.age = 0; q.life = 6 + Math.random() * 10;
      return q;
    }
    // The field breathes: circulation oscillates slowly and a weak second vortex drifts around.
    function vel(x, y, time) {
      var dx = x - p.sink[0], dy = y - p.sink[1], r2 = dx * dx + dy * dy + 1e-6;
      var g = p.gamma * (1 + 0.2 * Math.sin(time / 11));
      var vx = p.u0 - p.k * dx / r2 - g * dy / r2, vy = -p.k * dy / r2 + g * dx / r2;
      var cx = W * 0.28 + Math.cos(time / 23) * W * 0.16, cy = H * 0.5 + Math.sin(time / 17) * H * 0.22;
      var ex = x - cx, ey = y - cy, e2 = ex * ex + ey * ey + 900;
      vx += -0.3 * p.gamma * ey / e2; vy += 0.3 * p.gamma * ex / e2;
      if (mode === 'source') { vx = -vx; vy = -vy; }
      return { x: vx, y: vy };
    }
    function step(dt, time) {
      var gathering = performance.now() < gatherUntil;
      for (var i = 0; i < particles.length; i++) {
        var q = particles[i];
        var v = vel(q.x, q.y, time), n = Math.hypot(v.x, v.y) || 1;
        var speed = Math.min(14 + n * 0.9, 90) * (scale < 0.7 ? 1.6 : 1);   // figure units per second; brisker when the figure is small
        if (gathering) { v = { x: p.sink[0] - q.x, y: p.sink[1] - q.y }; n = Math.hypot(v.x, v.y) || 1; speed = 260; }
        q.px = q.x; q.py = q.y;
        q.x += v.x / n * speed * dt; q.y += v.y / n * speed * dt;
        q.age += dt;
        var d = Math.hypot(q.x - p.sink[0], q.y - p.sink[1]);
        var out = q.x < -4 || q.x > W + 4 || q.y < -4 || q.y > H + 4;
        if ((mode !== 'source' && d < 4) || out || q.age > q.life) particles[i] = seed(false);
      }
    }
    function draw() {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,0.07)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineCap = 'round';
      for (var pass = 0; pass < 2; pass++) {
        ctx.lineWidth = (pass === 1 ? 1.2 : 0.9) / scale;
        ctx.beginPath();
        for (var i = 0; i < particles.length; i++) {
          var q = particles[i];
          if (q.lum !== (pass === 1)) continue;
          if (Math.abs(q.x - q.px) > 30 || Math.abs(q.y - q.py) > 30) continue;
          ctx.moveTo(q.px, q.py); ctx.lineTo(q.x, q.y);
        }
        ctx.strokeStyle = pass === 1 ? colours.accent : colours.field;
        ctx.globalAlpha = pass === 1 ? 0.9 : 0.55;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    function frame(now) {
      if (!running) return;
      var dt = Math.min((now - last) / 1000, 0.05); last = now;
      step(dt, (now - t0) / 1000);
      draw();
      requestAnimationFrame(frame);
    }
    function run() { if (running || !visible || document.hidden) return; running = true; last = performance.now(); requestAnimationFrame(frame); }
    function stop() { running = false; }

    readColours(); resize();
    var io = null, mo = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (es) { visible = es[0].isIntersecting; visible ? run() : stop(); }, { threshold: 0.05 });
      io.observe(fig);
    } else run();
    var onVis = function () { document.hidden ? stop() : run(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', resize);
    mo = new MutationObserver(readColours);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    var mq = null;
    try { mq = window.matchMedia('(prefers-color-scheme: light)'); mq.addEventListener('change', readColours); } catch (e) {}
    var inst = {
      gather: function (ms) { gatherUntil = performance.now() + ms; run(); },
      destroy: function () {
        stop(); if (io) io.disconnect(); if (mo) mo.disconnect();
        document.removeEventListener('visibilitychange', onVis); window.removeEventListener('resize', resize);
        try { if (mq) mq.removeEventListener('change', readColours); } catch (e) {}
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
    fig.__afflux = inst;
    registry.instances.push(inst);
  }

  var figs = document.querySelectorAll('.field[data-live]');
  for (var i = 0; i < figs.length; i++) start(figs[i]);

  // Forms marked data-gather: the field converges on the point, then the form goes.
  var forms = document.querySelectorAll('form[data-gather]');
  for (var f = 0; f < forms.length; f++) {
    forms[f].addEventListener('submit', function (ev) {
      var form = ev.target;
      if (form.__gathered || !form.checkValidity()) return;
      var fig = document.querySelector('.field[data-live]');
      if (!fig || !fig.__afflux) return;
      ev.preventDefault();
      form.__gathered = true;
      fig.__afflux.gather(520);
      var btn = form.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
      setTimeout(function () { form.submit(); }, 520);
    });
  }
})();
