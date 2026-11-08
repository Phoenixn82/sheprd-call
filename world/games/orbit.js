// Orbit: a dot circles the ring. Tap turns it round. Pick up the stars on the ring and miss the rocks that land on it.
SheprdGames.add({
  id: 'orbit', name: 'Orbit', verb: 'Turn', hint: 'Tap to turn round. Stars good, rocks bad.',
  start(G) { G.score = 0; G.s = { a: 0, dir: 1, star: Math.PI, rocks: [], gap: 90, t: 0 }; },
  tap(G) { G.s.dir = -G.s.dir; },
  step(G, dt) {
    const s = G.s, speed = 0.045 + Math.min(0.04, G.score * 0.002);
    s.t++; s.a = (s.a + s.dir * speed * dt + Math.PI * 2) % (Math.PI * 2);
    const near = (b) => Math.abs(((s.a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.16;
    if (near(s.star)) { G.score++; s.star = G.rnd() * Math.PI * 2; }
    if ((s.gap -= dt) <= 0) { s.rocks.push({ a: G.rnd() * Math.PI * 2, life: 90 + G.rnd() * 60, warn: 30 }); s.gap = Math.max(40, 110 - G.score * 3); }
    for (const r of s.rocks) { if (r.warn > 0) r.warn -= dt; else r.life -= dt; }
    s.rocks = s.rocks.filter(r => r.life > 0);
    return s.rocks.some(r => r.warn <= 0 && near(r.a));
  },
  draw(G) {
    const s = G.s, cx = G.w / 2, cy = G.h / 2, R = Math.min(G.w, G.h) / 2 - 20;
    for (let i = 0; i < 32; i++) { const a = i / 32 * Math.PI * 2; G.rect(cx + Math.cos(a) * R - 1, cy + Math.sin(a) * R - 1, 2, 2); }
    G.rect(cx - 4, cy - 4, 8, 8);
    const sx = cx + Math.cos(s.star) * R, sy = cy + Math.sin(s.star) * R;
    G.rect(sx - 2, sy - 6, 4, 12); G.rect(sx - 6, sy - 2, 12, 4);
    for (const r of s.rocks) { const x = cx + Math.cos(r.a) * R, y = cy + Math.sin(r.a) * R; if (r.warn > 0) { if (Math.floor(s.t / 4) & 1) G.rect(x - 2, y - 2, 4, 4); } else { G.rect(x - 6, y - 6, 12, 12); G.g.clearRect(x - 2, y - 2, 4, 4); } }
    const px = cx + Math.cos(s.a) * R, py = cy + Math.sin(s.a) * R; G.rect(px - 5, py - 5, 10, 10);
  },
});
