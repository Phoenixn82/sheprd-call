// Shear: sheep trot past the shearing stall. Tap while one is in the stall to shear it; a tap on nothing, or a
// woolly sheep walking out, ends it.
SheprdGames.add({
  id: 'shear', name: 'Shear', verb: 'Shear', hint: 'Tap when a sheep is in the stall.',
  SHEEP: ['..3333..', '.333333.', '33333333', '.333333.', '..3..3..'],
  start(G) { G.score = 0; G.s = { sheep: [], gap: 30, t: 0 }; },
  tap(G) {
    const s = G.s, stall = this.stall(G), hit = s.sheep.find(h => !h.done && h.x + 16 > stall.x && h.x < stall.x + stall.w);
    if (hit) { hit.done = true; G.score++; } else s.dead = true;
  },
  stall(G) { const w = Math.max(28, 44 - G.score * 2); return { x: Math.round((G.w - w) / 2), w }; },
  step(G, dt) {
    const s = G.s, speed = 1.6 + Math.min(3, G.score / 6), stall = this.stall(G);
    s.t++;
    if ((s.gap -= speed * dt) <= 0) { s.sheep.push({ x: G.w + 10, done: false }); s.gap = 90 + G.rnd() * 90; }
    for (const h of s.sheep) { h.x -= speed * dt; if (!h.done && h.x + 16 < stall.x) s.dead = true; }
    s.sheep = s.sheep.filter(h => h.x > -20);
    return !!s.dead;
  },
  draw(G) {
    const s = G.s, stall = this.stall(G), y = G.h - 36;
    G.rect(0, y + 12, G.w, 2);
    G.rect(stall.x, y - 30, 4, 44); G.rect(stall.x + stall.w - 4, y - 30, 4, 44); G.rect(stall.x, y - 30, stall.w, 4);
    for (const h of s.sheep) {
      if (h.done) { G.rect(h.x + 4, y + 2, 10, 6); G.rect(h.x + 2, y + 8, 2, 4); G.rect(h.x + 12, y + 8, 2, 4); G.rect(h.x, y, 4, 6); }
      else { const walk = (Math.floor(s.t / 8) + Math.floor(h.x / 16)) & 1; this.SHEEP.forEach((row, r) => [...row].forEach((c, i) => { if (c === '3' && !(r === 4 && walk && i === 2)) G.g.fillRect(h.x + i * 2, y - 8 + r * 4, 2, 4); })); G.rect(h.x - 2, y - 4, 4, 6); }
    }
  },
});
