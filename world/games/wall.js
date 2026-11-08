// Wall: you cling to one wall and slide up; tap leaps to the other wall. Spikes grow on the walls; land on one and it's over.
SheprdGames.add({
  id: 'wall', name: 'Wall', verb: 'Leap', hint: 'Tap to leap to the other wall. Miss the spikes.',
  start(G) { G.score = 0; G.s = { side: 0, x: 12, air: 0, spikes: [], gap: 40, dist: 0 }; },
  tap(G) { const s = G.s; if (!s.air) { s.air = 1; s.side = 1 - s.side; } },
  step(G, dt) {
    const s = G.s, speed = 2 + Math.min(3, G.score / 20), far = G.w - 12 - 12;
    s.dist += speed * dt; G.score = Math.floor(s.dist / 20);
    if (s.air) { s.air = Math.max(0, s.air - 0.09 * dt); }
    const want = s.side ? G.w - 12 - 12 : 12; s.x += (want - s.x) * Math.min(1, 0.3 * dt);
    if ((s.gap -= speed * dt) <= 0) { s.spikes.push({ side: Math.floor(G.rnd() * 2), y: -10 }); s.gap = 60 + G.rnd() * 60; }
    for (const k of s.spikes) k.y += speed * dt;
    s.spikes = s.spikes.filter(k => k.y < G.h + 10);
    const py = G.h * 0.6;
    return !s.air && s.spikes.some(k => k.side === s.side && Math.abs(k.y - py) < 10);
  },
  draw(G) {
    const s = G.s;
    G.rect(0, 0, 10, G.h); G.rect(G.w - 10, 0, 10, G.h);
    for (const k of s.spikes) { const x = k.side ? G.w - 10 : 10; for (let i = 0; i < 3; i++) G.rect(k.side ? x - 4 * (3 - i) : x, k.y - 6 + i * 4, 4 * (3 - i), 4); }
    const py = G.h * 0.6, tilt = s.air ? (s.side ? -2 : 2) : 0;
    G.rect(s.x + tilt, py - 8, 12, 16); G.rect(s.x + (s.side ? -4 : 12) + tilt, py - 4, 4, 4);
  },
});
