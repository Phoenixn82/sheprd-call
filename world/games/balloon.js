// Balloon: hold to blow it up, let go inside the mark. Too small is a miss; too big and it pops.
SheprdGames.add({
  id: 'balloon', name: 'Balloon', verb: 'Blow', hint: 'Hold to blow, let go inside the mark.',
  start(G) { G.score = 0; G.s = { r: 6, hold: false, lo: 0, hi: 0, max: 0, pop: 0, settle: 0 }; this.aim(G); },
  aim(G) { const s = G.s, max = Math.min(G.w, G.h) / 2 - 16, band = Math.max(6, 22 - G.score * 1.5); s.max = max; s.lo = 14 + G.rnd() * (max - band - 20); s.hi = s.lo + band; s.r = 6; },
  tap(G) { if (!G.s.pop) G.s.hold = true; },
  release(G) {
    const s = G.s; if (!s.hold) return; s.hold = false;
    if (s.r >= s.lo && s.r <= s.hi) { G.score++; s.settle = 20; } else s.dead = true;
  },
  step(G, dt) {
    const s = G.s;
    if (s.settle > 0) { s.settle -= dt; if (s.settle <= 0) this.aim(G); return false; }
    if (s.hold) { s.r += (0.9 + Math.min(1.5, G.score * 0.12)) * dt; if (s.r > s.max) { s.pop = 1; return true; } }
    return !!s.dead;
  },
  draw(G) {
    const s = G.s, cx = G.w / 2, cy = G.h / 2 + 6;
    const ring = (r, step) => { for (let a = 0; a < Math.PI * 2; a += step / r) G.rect(cx + Math.cos(a) * r - 1, cy + Math.sin(a) * r - 1, 2, 2); };
    ring(s.lo, 3); ring(s.hi, 3);
    G.g.beginPath(); G.g.arc(cx, cy, s.r, 0, Math.PI * 2); G.g.fill();
    G.g.clearRect(Math.round((cx - s.r * 0.5) / 4) * 4, Math.round((cy - s.r * 0.6) / 4) * 4, 4, 4);
    G.rect(cx - 2, cy + s.r, 4, 6); G.rect(cx - 1, cy + s.r + 6, 2, 14);
  },
});
