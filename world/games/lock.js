// Lock: the needle sweeps along the bar; tap while it is inside the mark. Each hit moves the mark and narrows it.
SheprdGames.add({
  id: 'lock', name: 'Lock', verb: 'Tap', hint: 'Tap when the needle is inside the mark.',
  start(G) { G.score = 0; G.s = { p: 0, dir: 1, mark: 0.5, w: 0.22, flash: 0 }; },
  tap(G) {
    const s = G.s;
    if (Math.abs(s.p - s.mark) <= s.w / 2) { G.score++; s.w = Math.max(0.06, s.w * 0.92); s.mark = s.w / 2 + G.rnd() * (1 - s.w); s.dir = -s.dir; s.flash = 6; }
    else s.dead = true;
  },
  step(G, dt) {
    const s = G.s, speed = 0.012 + Math.min(0.02, G.score * 0.001);
    s.p += s.dir * speed * dt; if (s.p > 1) { s.p = 1; s.dir = -1; } if (s.p < 0) { s.p = 0; s.dir = 1; }
    if (s.flash > 0) s.flash -= dt;
    return !!s.dead;
  },
  draw(G) {
    const s = G.s, x0 = 16, x1 = G.w - 16, y = G.h / 2, len = x1 - x0;
    G.rect(x0, y - 2, len, 4); G.rect(x0, y - 10, 4, 20); G.rect(x1 - 4, y - 10, 4, 20);
    const mx = x0 + len * (s.mark - s.w / 2), mw = len * s.w;
    G.rect(mx, y - 8, mw, 16); G.g.clearRect(Math.round(mx / 4) * 4 + 4, Math.round((y - 8) / 4) * 4 + 4, Math.max(0, Math.round(mw / 4) * 4 - 8), 8);
    if (s.flash > 0) G.rect(mx, y - 8, mw, 16);
    const nx = x0 + len * s.p; G.rect(nx - 2, y - 20, 4, 40); G.rect(nx - 6, y - 24, 12, 4);
  },
});
