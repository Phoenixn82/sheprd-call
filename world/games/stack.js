// Stack: a slab slides across; tap drops it on the pile. The overhang falls off, so each one gets harder to land.
SheprdGames.add({
  id: 'stack', name: 'Stack', verb: 'Drop', hint: 'Tap to drop the slab on the pile.',
  start(G) { const w = Math.min(96, G.w * 0.4); G.score = 0; G.s = { pile: [{ x: (G.w - w) / 2, w }], x: 0, w, dir: 1, drop: 0, rise: 0 }; },
  tap(G) {
    const s = G.s, top = s.pile[s.pile.length - 1];
    const left = Math.max(s.x, top.x), right = Math.min(s.x + s.w, top.x + top.w);
    if (right - left < G.px) { s.dead = true; return; }
    s.pile.push({ x: left, w: right - left }); s.w = right - left; G.score++;
    s.dir = -s.dir; s.x = s.dir > 0 ? -s.w : G.w;
  },
  step(G, dt) {
    const s = G.s, speed = 2.2 + Math.min(4, G.score / 6);
    s.x += s.dir * speed * dt;
    if (s.x > G.w) s.dir = -1; if (s.x + s.w < 0) s.dir = 1;
    return !!s.dead;
  },
  draw(G) {
    const s = G.s, H = 12, base = G.h - 8, shown = s.pile.slice(-Math.floor((G.h - 60) / H));
    const off = s.pile.length - shown.length;
    shown.forEach((p, i) => { G.rect(p.x, base - (i + 1) * H, p.w, H); if ((i + off) % 2) G.g.clearRect(p.x + 4, base - (i + 1) * H + 4, p.w - 8, 2); });
    G.rect(s.x, base - (shown.length + 1) * H - 24, s.w, H);
    G.rect(0, base, G.w, 4);
  },
});
