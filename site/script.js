(() => {
  'use strict';
  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LANG_KEY = 'x-agent-site-lang';

  // ---- Language ----
  const shot = document.querySelector('[data-shot]');
  function setLang(lang, persist) {
    const next = lang === 'en' ? 'en' : 'zh';
    root.lang = next === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-lang]').forEach((el) => { el.hidden = el.dataset.lang !== next; });
    document.querySelectorAll('[data-set-lang]').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.setLang === next)));
    document.title = next === 'zh' ? 'X-Agent-Webui — 长对话，不失忆' : 'X-Agent-Webui — Long conversations. No amnesia.';
    if (shot) {
      const src = shot.dataset['src' + (next === 'zh' ? 'Zh' : 'En')];
      if (src && shot.getAttribute('src') !== src) shot.setAttribute('src', src);
      shot.alt = shot.dataset['alt' + (next === 'zh' ? 'Zh' : 'En')] || shot.alt;
    }
    if (persist) { try { localStorage.setItem(LANG_KEY, next); } catch (e) { /* storage unavailable */ } }
  }
  let saved = null;
  try { saved = localStorage.getItem(LANG_KEY); } catch (e) { /* storage unavailable */ }
  const preferred = saved || ((navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en');
  setLang(preferred, false);
  document.querySelectorAll('[data-set-lang]').forEach((btn) => btn.addEventListener('click', () => setLang(btn.dataset.setLang, true)));

  // ---- Mobile menu ----
  const menuBtn = document.querySelector('[data-menu]');
  const nav = document.getElementById('site-nav');
  function setMenu(open) { menuBtn.setAttribute('aria-expanded', String(open)); nav.classList.toggle('open', open); }
  menuBtn.addEventListener('click', () => setMenu(menuBtn.getAttribute('aria-expanded') !== 'true'));
  nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuBtn.getAttribute('aria-expanded') === 'true') { setMenu(false); menuBtn.focus(); } });

  // ---- Copy install command ----
  const copyBtn = document.querySelector('[data-copy]');
  const copyStatus = document.querySelector('[data-copy-status]');
  const command = document.getElementById('install-command');
  function say(zh, en) { copyStatus.textContent = root.lang === 'en' ? en : zh; }
  copyBtn.addEventListener('click', async () => {
    const text = command.textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      say('已复制到剪贴板', 'Copied to clipboard');
    } catch (e) {
      const range = document.createRange(); range.selectNodeContents(command);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      say('已选中命令，请按 Ctrl/⌘ + C 复制', 'Command selected — press Ctrl/⌘ + C to copy');
    }
  });

  // ---- Reveal on scroll ----
  const revealTargets = document.querySelectorAll('.section-head, .card, .browser, .terminal, .cta');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealTargets.forEach((el) => el.classList.add('reveal', 'in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealTargets.forEach((el) => { if (!el.closest('.hero')) { el.classList.add('reveal'); io.observe(el); } });
  }

  // ---- Context-flow canvas ----
  const canvas = document.querySelector('.flow-canvas');
  const meter = document.querySelector('[data-ctx]');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const W = 560, H = 440, GATE = H * 0.47;
  const SUM = { x: W * 0.5, y: H * 0.3, w: W * 0.45, h: H * 0.085 };
  const COLORS = { user: ['#67e8f9', 'rgba(103,232,249,0.22)'], assistant: ['#818cf8', 'rgba(129,140,248,0.16)'], tool: ['#4b5578', 'rgba(75,85,120,0.25)'] };
  let bars = [], glow = 0, flash = 0, ctxTokens = 352, running = false, raf = 0, last = 0;

  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function spawn(y) {
    const r = Math.random();
    const type = r < 0.28 ? 'user' : r < 0.62 ? 'assistant' : 'tool';
    const w = type === 'tool' ? 90 + Math.random() * 110 : 60 + Math.random() * 120;
    const span = type === 'user' ? W * 0.44 : W * 0.86;
    return { type, x: W * 0.07 + Math.random() * Math.max(10, span - w), y, w, h: type === 'tool' ? 9 : 12, v: 0.5, a: 1, fold: 0 };
  }
  const GAP = 24;
  function nextY() { return Math.max(H + 12, bars.reduce((m, b) => Math.max(m, b.y), -Infinity) + GAP); }
  function seed() {
    bars = [];
    for (let y = H * 0.1; y < GATE - 10; y += GAP * 1.6) { const b = spawn(y); b.type = 'user'; b.h = 12; b.x = W * 0.07 + Math.random() * Math.max(10, W * 0.44 - b.w); bars.push(b); }
    for (let y = GATE + 16; y < H + 12; y += GAP) bars.push(spawn(y));
  }
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function step(dt) {
    for (const b of bars) {
      b.y -= b.v * dt;
      if (b.type !== 'user' && b.y < GATE) {
        b.fold = Math.min(1, b.fold + 0.018 * dt);
        const tx = SUM.x + SUM.w * 0.5 - b.w * 0.5, ty = SUM.y + SUM.h * 0.5;
        b.x += (tx - b.x) * 0.04 * dt; b.y += (ty - b.y) * 0.03 * dt;
        b.a = 1 - b.fold;
        if (b.fold >= 1) { b.dead = true; glow = Math.min(1, glow + 0.35); }
      } else if (b.type === 'user' && b.y < H * 0.08) {
        b.a -= 0.02 * dt; if (b.a <= 0) b.dead = true;
      }
    }
    bars = bars.filter((b) => !b.dead);
    while (bars.filter((b) => b.y > GATE).length < 11) bars.push(spawn(nextY()));
    glow = Math.max(0, glow - 0.01 * dt);
    flash = Math.max(0, flash - 0.02 * dt);
    ctxTokens += 0.09 * dt;
    if (ctxTokens >= 400) { ctxTokens = 86; flash = 1; }
    if (meter) meter.textContent = Math.round(ctxTokens) + 'K';
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // gate
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(103,232,249,0)'); g.addColorStop(0.5, 'rgba(129,140,248,' + (0.75 + flash * 0.25) + ')'); g.addColorStop(1, 'rgba(192,132,252,0)');
    ctx.fillStyle = g; ctx.fillRect(0, GATE - 1, W, 2 + flash * 2);
    ctx.fillStyle = 'rgba(129,140,248,' + (0.06 + flash * 0.18) + ')'; ctx.fillRect(0, GATE - 22, W, 44);
    // summary band
    rr(SUM.x, SUM.y, SUM.w, SUM.h, 10);
    const sg = ctx.createLinearGradient(SUM.x, 0, SUM.x + SUM.w, 0);
    sg.addColorStop(0, 'rgba(129,140,248,' + (0.22 + glow * 0.3) + ')'); sg.addColorStop(1, 'rgba(192,132,252,' + (0.3 + glow * 0.35) + ')');
    ctx.fillStyle = sg; ctx.fill();
    ctx.strokeStyle = 'rgba(192,132,252,' + (0.5 + glow * 0.4) + ')'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = 'rgba(232,235,247,0.55)';
    for (let i = 0; i < 3; i++) ctx.fillRect(SUM.x + 14, SUM.y + 9 + i * 8, SUM.w * (0.7 - i * 0.16), 2.5);
    // bars
    for (const b of bars) {
      const [stroke, fill] = COLORS[b.type];
      const h = b.h * (1 - b.fold * 0.75), w = b.w * (1 - b.fold * 0.55);
      ctx.globalAlpha = Math.max(0, Math.min(1, b.a));
      rr(b.x, b.y, w, h, Math.min(5, h / 2));
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = b.type === 'user' ? 1.4 : 1; ctx.stroke();
      if (b.type === 'user') { ctx.shadowColor = '#67e8f9'; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0; }
    }
    ctx.globalAlpha = 1;
  }

  function frame(t) {
    if (!running) return;
    const dt = last ? Math.min(3, (t - last) / 16.7) : 1; last = t;
    step(dt); draw();
    raf = requestAnimationFrame(frame);
  }
  function start() { if (running || reduceMotion) return; running = true; last = 0; raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }

  fit(); seed();
  if (reduceMotion) { for (let i = 0; i < 160; i++) step(1); draw(); return; }
  draw();
  let visible = true;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; if (visible && !document.hidden) start(); else stop(); }).observe(canvas);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (visible) start(); });
  window.addEventListener('resize', () => { fit(); draw(); });
  start();
})();
