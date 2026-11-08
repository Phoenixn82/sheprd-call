// Bridge: hold to grow the plank, let go to drop it. Reach the next post and walk over; too short or too long and you fall.
SheprdGames.add({
  id: 'bridge', name: 'Bridge', verb: 'Hold', hint: 'Hold to grow the plank, let go to drop it.',
  start(G) { G.score = 0; G.s = { posts: [{ x: 10, w: 40 }], plank: 0, hold: false, phase: 'stand', walk: 0, shift: 0 }; this.next(G); },
  next(G) { const s = G.s, last = s.posts[s.posts.length - 1], w = 20 + G.rnd() * 30; s.posts.push({ x: last.x + last.w + 40 + G.rnd() * (G.w - last.x - last.w - 80 > 40 ? Math.min(140, G.w - last.x - last.w - 80) : 1), w }); },
  tap(G) { const s = G.s; if (s.phase === 'stand') { s.phase = 'grow'; s.hold = true; } },
  release(G) { const s = G.s; s.hold = false; if (s.phase === 'grow') s.phase = 'fall'; },
  step(G, dt) {
    const s = G.s, me = s.posts[0], to = s.posts[1];
    if (s.phase === 'grow') s.plank += 2.2 * dt;
    else if (s.phase === 'fall') { s.phase = 'walk'; s.walk = 0; const end = me.x + me.w + s.plank; s.ok = end >= to.x && end <= to.x + to.w; }
    else if (s.phase === 'walk') {
      s.walk += 2.4 * dt;
      if (s.walk >= s.plank + (s.ok ? to.w / 2 : 0)) { if (!s.ok) return true; G.score++; s.phase = 'shift'; }
    } else if (s.phase === 'shift') {
      const step = Math.min(4 * dt, to.x - 10); s.posts.forEach(p => { p.x -= step; });
      if (to.x <= 10.01) { s.posts.shift(); s.plank = 0; s.phase = 'stand'; this.next(G); }
    }
    return false;
  },
  draw(G) {
    const s = G.s, me = s.posts[0], ground = G.h - 20;
    for (const p of s.posts) G.rect(p.x, ground - 60, p.w, 80);
    const px = me.x + me.w;
    if (s.phase === 'grow') G.rect(px - 4, ground - 60 - s.plank, 4, s.plank);
    else if (s.plank) G.rect(px - 4, ground - 64, s.plank + 4, 4);
    const wx = s.phase === 'walk' || s.phase === 'shift' ? px - 10 + Math.min(s.walk, s.plank + 4 + (s.ok ? s.posts[1].w / 2 : 0)) : px - 12;
    const wy = s.phase === 'walk' && !s.ok && s.walk > s.plank ? ground - 76 + (s.walk - s.plank) * 3 : ground - 76;
    G.rect(wx, wy, 8, 12); G.rect(wx + 2, wy - 4, 4, 4);
  },
});
