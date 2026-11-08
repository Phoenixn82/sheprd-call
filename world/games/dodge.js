// Dodge: three lanes, blocks coming down. Tap steps you one lane to the right (and round again).
SheprdGames.add({
  id: 'dodge', name: 'Dodge', verb: 'Step', hint: 'Tap to step a lane over. Dodge the blocks.',
  start(G) { G.score = 0; G.s = { lane: 1, blocks: [], gap: 10, t: 0 }; },
  tap(G) { G.s.lane = (G.s.lane + 1) % 3; },
  step(G, dt) {
    const s = G.s, speed = 2.4 + Math.min(4, G.score / 8), laneW = G.w / 3;
    s.t++;
    if ((s.gap -= dt) <= 0) { const lane = Math.floor(G.rnd() * 3); s.blocks.push({ lane, y: -16 }); if (G.rnd() < 0.3) s.blocks.push({ lane: (lane + 1 + Math.floor(G.rnd() * 2)) % 3, y: -16 }); s.gap = Math.max(26, 70 - G.score * 2); }
    for (const b of s.blocks) { b.y += speed * dt; if (!b.passed && b.y > G.h - 24) { b.passed = true; G.score++; } }
    s.blocks = s.blocks.filter(b => b.y < G.h + 20);
    return s.blocks.some(b => b.lane === s.lane && b.y + 14 > G.h - 24 && b.y < G.h - 8);
  },
  draw(G) {
    const s = G.s, laneW = G.w / 3;
    for (let i = 1; i < 3; i++) for (let y = (s.t * 2) % 16 - 16; y < G.h; y += 16) G.rect(i * laneW - 1, y, 2, 8);  // dashed lane lines
    for (const b of s.blocks) G.rect(b.lane * laneW + laneW / 2 - 10, b.y, 20, 14);
    const x = s.lane * laneW + laneW / 2;
    G.rect(x - 8, G.h - 24, 16, 16); G.rect(x - 4, G.h - 28, 8, 4); G.g.clearRect(x - 5, G.h - 19, 3, 3); G.g.clearRect(x + 2, G.h - 19, 3, 3);
  },
});
