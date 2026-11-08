// Node-only check of the waiting games as drop-in modules: every id in world/games.js's REGISTRY has its file under
// world/games/, no file there is unregistered, each module registers the required hooks and strings, and each game
// runs headless (fake 2d context, 412x300 board) under random taps without throwing, scoring, and ending a run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dir = __dirname + '/world/';
const context = { document: undefined };
vm.runInNewContext(fs.readFileSync(dir + 'games.js', 'utf8'), context);
const R = context.SheprdGames;
const plain = (v) => JSON.parse(JSON.stringify(v));  // vm arrays live in another realm
assert.ok(R.REGISTRY.length >= 11, 'the registry lists the runner and ten more');
assert.deepEqual([...new Set(R.REGISTRY)], plain(R.REGISTRY), 'no id twice');
for (const id of R.REGISTRY) {
  assert.match(id, /^[a-z]+$/, id + ': ids are lower-case letters (the /sheprd/games/<id>.js route)');
  assert.ok(fs.existsSync(dir + 'games/' + id + '.js'), 'registered game "' + id + '" has no world/games/' + id + '.js');
  vm.runInNewContext(fs.readFileSync(dir + 'games/' + id + '.js', 'utf8'), context, { filename: id + '.js' });
  const g = R.get(id);
  assert.ok(g, id + '.js did not register itself (SheprdGames.add with id "' + id + '")');
  for (const h of R.HOOKS) assert.equal(typeof g[h], 'function', id + ' lacks ' + h + '()');
  for (const s of ['name', 'verb', 'hint']) assert.ok(typeof g[s] === 'string' && g[s], id + ' lacks ' + s);
}
const orphans = fs.readdirSync(dir + 'games').filter((f) => f.endsWith('.js') && !R.REGISTRY.includes(f.slice(0, -3)));
assert.deepEqual(orphans, [], 'files under world/games not in the registry');
assert.deepEqual(plain(R.list().map((g) => g.id)), plain(R.REGISTRY), 'list() is the registry in order');
assert.throws(() => R.add({ id: 'nope', name: 'x', verb: 'x', hint: 'x', start() {}, tap() {}, step() {}, draw() {} }), /not in the registry/);
assert.throws(() => R.add({ id: R.REGISTRY[0], name: 'x', verb: 'x', hint: 'x', start() {}, tap() {}, step() {} }), /lacks draw/);
console.log('PASS: registry of ' + R.REGISTRY.length + ' games, every file present and complete, no orphans');

// A fake board: the page's G, with a 2d context that only counts calls.
let calls = 0;
const g = new Proxy({ globalAlpha: 1, font: '', textAlign: '' }, { get(t, k) { return k in t ? t[k] : () => { calls++; }; }, set(t, k, v) { t[k] = v; return true; } });
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
function board() {
  return { w: 412, h: 300, px: 4, g, ink: '#1e2c24', paper: '#e4ecc8', score: 0, s: null, rnd,
    rect(x, y, w, h) { assert.ok([x, y, w, h].every(Number.isFinite), 'rect with a non-number'); calls++; },
    text() { calls++; }, rows() { calls++; } };
}
for (const game of R.list()) {
  const G = board();
  game.start(G);
  assert.equal(G.score, 0, game.id + ': start sets score 0');
  game.draw(G);
  assert.ok(calls > 0, game.id + ': draw paints something');
  let over = false, steps = 0, best = 0, runs = 0;
  // random play: tap now and then, hold for a while (hold games need release), until the run ends, several runs
  while (runs < 3 && steps < 20000) {
    const r = rnd();
    if (r < 0.06) game.tap(G); else if (r < 0.1 && game.release) game.release(G);
    over = !!game.step(G, 1); game.draw(G); steps++;
    assert.ok(Number.isFinite(G.score) && G.score >= 0, game.id + ': score is a number');
    if (over) { best = Math.max(best, G.score); runs++; game.start(G); }
  }
  assert.ok(runs >= 1, game.id + ': a run never ended in ' + steps + ' steps');
  // a deliberate player scores: the simplest strategies for the one button
  const H = board(); game.start(H); let scored = 0;
  for (let i = 0; i < 6000 && !scored; i++) {
    if (game.id === 'run' && H.s.obs.some((o) => o.x > 40 && o.x < 70) && H.s.y === 0) game.tap(H);
    if (game.id === 'flap') { const p = H.s.posts.find((p) => p.x + 14 > 32), aim = p ? p.top + p.hole / 2 - 4 : H.h / 2; if (H.s.y > aim && H.s.vy > -1) game.tap(H); }
    if (game.id === 'catch') { const a = H.s.apples[0]; if (a && Math.sign(a.x - H.s.x) !== H.s.dir && Math.abs(a.x - H.s.x) > 4) game.tap(H); }
    if (game.id === 'dodge') { const b = H.s.blocks.find((b) => b.lane === H.s.lane && b.y > H.h - 120 && b.y < H.h - 40); if (b) game.tap(H); }
    if (game.id === 'stack' && Math.abs(H.s.x - H.s.pile[0].x) < 2) game.tap(H);
    if (game.id === 'wall' && !H.s.air && H.s.spikes.some((k) => k.side === H.s.side && k.y > H.h * 0.6 - 60 && k.y < H.h * 0.6 - 20)) game.tap(H);
    if (game.id === 'lock' && Math.abs(H.s.p - H.s.mark) < H.s.w / 4) game.tap(H);
    if (game.id === 'shear') { const st = game.stall(H), s = H.s.sheep.find((s) => !s.done && s.x + 16 > st.x && s.x + 16 < st.x + st.w); if (s) game.tap(H); }
    if (game.id === 'orbit') { const r = H.s.rocks.find((r) => r.warn <= 0); if (r && Math.abs(((H.s.a - r.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.5 && Math.sign(Math.sin(r.a - H.s.a)) === H.s.dir) game.tap(H); }
    if (game.id === 'bridge') { const s = H.s; if (s.phase === 'stand') game.tap(H); if (s.phase === 'grow' && s.posts[0].x + s.posts[0].w + s.plank >= s.posts[1].x + s.posts[1].w / 2) game.release(H); }
    if (game.id === 'balloon') { const s = H.s; if (!s.hold && !s.settle) game.tap(H); if (s.hold && s.r >= (s.lo + s.hi) / 2) game.release(H); }
    if (game.step(H, 1)) break;
    scored = H.score;
  }
  assert.ok(scored > 0, game.id + ': the simple strategy never scored');
  console.log('PASS: ' + game.id + ' (' + game.name + ', ' + game.verb + '): ' + runs + ' random runs ended, best ' + Math.floor(best) + ', strategy scored ' + Math.floor(scored));
}
