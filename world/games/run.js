// Run: the cactus jumper (2026-11-02: the offline dino game, but Claude's ASCII mascot). Tap to jump the posts.
SheprdGames.add({
  id: 'run', name: 'Run', verb: 'Jump', hint: 'Tap to jump the posts.',
  BODY: [' ▐▛███▜▌ ', '▝▜█████▛▘'], LEGS: ['  ▘▘ ▝▝  ', '  ▝▘ ▘▝  '],
  start(G) { G.score = 0; G.s = { y: 0, vy: 0, obs: [], speed: 6, gap: 300, tick: 0 }; },
  tap(G) { const s = G.s; if (s.y === 0) s.vy = 11.5; },
  step(G, dt) {
    const s = G.s, PX = G.px, W = 9 * 2 * PX, ground = G.h - 26;
    s.tick++;
    s.vy -= 0.9 * dt; s.y = Math.max(0, s.y + s.vy * dt); if (s.y === 0) s.vy = 0;
    s.speed = Math.min(13, s.speed + 0.002 * dt); G.score += s.speed * dt / 10;
    s.obs.forEach(o => { o.x -= s.speed * dt; }); s.obs = s.obs.filter(o => o.x > -20);
    if ((s.gap -= s.speed * dt) <= 0) { s.obs.push({ x: G.w + 10, w: 10 + G.rnd() * 8, h: 18 + G.rnd() * 22 }); s.gap = 220 + G.rnd() * 260; }
    return s.obs.some(o => o.x < 24 + W - 6 && o.x + o.w > 24 + 6 && ground - s.y > ground - o.h + 4);
  },
  draw(G) {
    const s = G.s, PX = G.px, H = 3 * 2 * PX, ground = G.h - 26;
    for (let x = ((-s.tick * s.speed) % 16 + 16) % 16 - 16; x < G.w; x += 16) G.g.fillRect(x, ground, 8, 3);  // dashed pixel ground
    s.obs.forEach(o => { const x = Math.round(o.x / PX) * PX, h = Math.round(o.h / PX) * PX, bw = Math.round(o.w / PX) * PX;
      G.g.fillRect(x, ground - h, bw, h); G.g.fillRect(x - PX, ground - h + 2 * PX, bw + 2 * PX, PX); G.g.fillRect(x + PX, ground - h - PX, bw - 2 * PX, PX); });
    G.rows([...this.BODY, this.LEGS[s.y > 0 ? 0 : (s.tick >> 3) & 1]], 24, ground - H - s.y);
  },
});
