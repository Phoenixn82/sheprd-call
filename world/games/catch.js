// Catch: a basket slides back and forth on its own; tap turns it round. Catch the falling apples; three misses end it.
SheprdGames.add({
  id: 'catch', name: 'Catch', verb: 'Turn', hint: 'Tap to turn the basket. Three misses and it tips.',
  start(G) { G.score = 0; G.s = { x: G.w / 2, dir: 1, apples: [], gap: 20, miss: 0, t: 0 }; },
  tap(G) { G.s.dir = -G.s.dir; },
  step(G, dt) {
    const s = G.s, fall = 1.8 + Math.min(3, G.score / 10);
    s.t++; s.x += s.dir * 3.2 * dt;
    if (s.x < 14) { s.x = 14; s.dir = 1; } if (s.x > G.w - 14) { s.x = G.w - 14; s.dir = -1; }
    if ((s.gap -= dt) <= 0) { s.apples.push({ x: 10 + G.rnd() * (G.w - 20), y: -8 }); s.gap = Math.max(22, 60 - G.score * 1.5); }
    for (const a of s.apples) {
      a.y += fall * dt;
      if (a.y + 6 >= G.h - 22 && a.y < G.h - 12 && Math.abs(a.x - s.x) < 16) { a.got = true; G.score++; }
      else if (a.y > G.h) { a.got = true; s.miss++; }
    }
    s.apples = s.apples.filter(a => !a.got);
    return s.miss >= 3;
  },
  draw(G) {
    const s = G.s;
    for (const a of s.apples) { G.rect(a.x - 3, a.y, 6, 6); G.rect(a.x, a.y - 3, 2, 3); }
    G.rect(s.x - 14, G.h - 20, 28, 4); G.rect(s.x - 12, G.h - 16, 24, 10); G.rect(s.x - 10, G.h - 12, 20, 4);
    for (let i = 0; i < 3; i++) G.g.globalAlpha = i < 3 - s.miss ? 1 : 0.25, G.rect(8 + i * 12, 8, 8, 8);
    G.g.globalAlpha = 1;
  },
});
