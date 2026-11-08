// Flap: a little bird through gaps in the posts. One tap flaps it up; gravity does the rest.
SheprdGames.add({
  id: 'flap', name: 'Flap', verb: 'Flap', hint: 'Tap to flap through the gaps.',
  start(G) { G.score = 0; G.s = { y: G.h / 2, vy: 0, posts: [], gap: 0, t: 0 }; },
  tap(G) { G.s.vy = -5.6; },
  step(G, dt) {
    const s = G.s, speed = 2.6 + Math.min(2, G.score / 15);
    s.t++; s.vy = Math.min(9, s.vy + 0.32 * dt); s.y += s.vy * dt;
    if ((s.gap -= speed * dt) <= 0) { const hole = 78; s.posts.push({ x: G.w + 20, top: 20 + G.rnd() * Math.max(10, G.h - hole - 50), hole, passed: false }); s.gap = 150; }
    for (const p of s.posts) { p.x -= speed * dt; if (!p.passed && p.x + 14 < 40) { p.passed = true; G.score++; } }
    s.posts = s.posts.filter(p => p.x > -20);
    if (s.y < 4 || s.y > G.h - 14) return true;
    return s.posts.some(p => p.x < 48 && p.x + 14 > 32 && (s.y < p.top || s.y + 8 > p.top + p.hole));
  },
  draw(G) {
    const s = G.s;
    for (const p of s.posts) { G.rect(p.x, 0, 14, p.top); G.rect(p.x - 4, p.top - 6, 22, 6); G.rect(p.x, p.top + p.hole, 14, G.h); G.rect(p.x - 4, p.top + p.hole, 22, 6); }
    G.rect(32, s.y, 12, 8); G.rect(44, s.y + 2, 4, 4);  // body, beak
    G.rect(28, s.y + (s.vy < 0 ? -2 : 4), 8, 4);  // the wing, up on a flap
    G.rect(G.w - 4, 0, 4, G.h);
  },
});
