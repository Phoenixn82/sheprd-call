// Sheprd world: 16x16 tiles, larger objects and the pasture map. Shades '0' light .. '3' dark.
(function (root) {
  'use strict';
  const SH = root.SHEPRD = root.SHEPRD || {};
  const G = SH.Grid;
  const R = rows => G.fromRows(rows);

  const T = SH.TILES = {};

  T.grass = R([
    '1111111111111111',
    '1111111111111111',
    '1111111111121211',
    '1111111111111111',
    '1111111111111111',
    '1121211111111111',
    '1111111111111111',
    '1111111111111111',
    '1111111111111111',
    '1111111112121111',
    '1111111111111111',
    '1111111111111111',
    '1112121111111111',
    '1111111111111111',
    '1111111111111111',
    '1111111111111111',
  ]);
  T.grass2 = R([ // denser tufts
    '1111111111111111',
    '1112121111111111',
    '1111211111121211',
    '1111111111112111',
    '1111111111111111',
    '1111111111111111',
    '1111112121111111',
    '1111111211111111',
    '1111111111111111',
    '1121211111111111',
    '1112111111121211',
    '1111111111112111',
    '1111111111111111',
    '1111111111111111',
    '1111121211111111',
    '1111112111111111',
  ]);
  T.flowers = R([
    '1111111111111111',
    '1111111111101111',
    '1111111111000111',
    '1111111111101111',
    '1111111111121111',
    '1101111111111111',
    '1000111111111111',
    '1101111111111111',
    '1121111111111111',
    '1111111111111111',
    '1111111011111111',
    '1111110001111111',
    '1111111011111111',
    '1111111211111111',
    '1111111111111111',
    '1111111111111111',
  ]);
  T.path = R([
    '0000000000000000',
    '0000000000000000',
    '0000001000000000',
    '0000000000000010',
    '0000000000000000',
    '0100000000000000',
    '0000000000100000',
    '0000000000000000',
    '0000000000000000',
    '0000100000000000',
    '0000000000000100',
    '0000000000000000',
    '0000000010000000',
    '0010000000000000',
    '0000000000000000',
    '0000000000000000',
  ]);
  // Fence: post at the left edge, two rails. Repeats every tile.
  T.fence = R([
    '1111111111111111',
    '1111111111111111',
    '3333111111111111',
    '3023111111111111',
    '3023111111111111',
    '3023000000000000',
    '3023222222222222',
    '3023333333333333',
    '3023111111111111',
    '3023111111111111',
    '3023000000000000',
    '3023222222222222',
    '3023333333333333',
    '3023111111111111',
    '3333111111111111',
    '1111111111111111',
  ]);
  T.fenceEnd = R([ // lone post closing a fence run
    '1111111111111111',
    '1111111111111111',
    '3333111111111111',
    '3023111111111111',
    '3023111111111111',
    '3023111111111111',
    '3023111111111111',
    '3023111111111111',
    '3023111111111111',
    '3023111111111111',
    '3023111111111111',
    '3023111111111111',
    '3023111111111111',
    '3023111111111111',
    '3333111111111111',
    '1111111111111111',
  ]);
  T.rock = R([
    '1111111111111111',
    '1111111111111111',
    '1111113331111111',
    '1111330003311111',
    '1113000000031111',
    '1130000000003111',
    '1300000100000311',
    '1300001110000311',
    '1300011120000311',
    '1300111222000311',
    '1301112222200311',
    '1132122222223111',
    '1113222222231111',
    '1111333333311111',
    '1111113331111111',
    '1111111111111111',
  ]);
  T.tree = R([
    '.....333333.....',
    '...3311112233...',
    '..31111122223...',
    '.31111112222223.',
    '.31112222222223.',
    '.32122222222223.',
    '.32222222222223.',
    '.32222222222233.',
    '..322222222233..',
    '..332222222333..',
    '...3333333333...',
    '......3223......',
    '......3223......',
    '......3223......',
    '.....332233.....',
    '....33333333....',
  ]);
  T.stump = R([ // short dark hedge/bush filler for corners
    '1111111111111111',
    '1111333333331111',
    '1113222222223111',
    '1132212222122311',
    '1322222222222231',
    '1322122222212231',
    '1322222222222231',
    '1322222122222231',
    '1322222222222231',
    '1322122222212231',
    '1132222222222311',
    '1113222222223111',
    '1111333333331111',
    '1111111111111111',
    '1111111111111111',
    '1111111111111111',
  ]);

  // Gate: 32x16, posts at both ends, three bars and a diagonal brace.
  T.gate = (function () {
    const g = new G(32, 16, '1');
    const post = (x) => { g.rect(x, 2, 4, 13, '3'); g.vline(x + 1, 3, 11, '0'); g.vline(x + 2, 3, 11, '2'); };
    post(0); post(28);
    // panel between x=4..27
    g.rect(4, 3, 24, 11, '3');            // outline block
    g.rect(5, 4, 22, 9, '1');             // see-through
    g.rect(4, 4, 24, 2, '0'); g.hline(4, 6, 24, '2'); // top bar: light + mid
    g.rect(4, 9, 24, 2, '0'); g.hline(4, 11, 24, '2'); // middle bar
    g.hline(4, 13, 24, '2');              // bottom bar (thin)
    g.hline(4, 3, 24, '3'); g.hline(4, 7, 24, '3'); g.hline(4, 12, 24, '3');
    g.vline(4, 3, 11, '3'); g.vline(27, 3, 11, '3'); // stiles
    g.line(6, 12, 25, 4, '3');                       // diagonal brace (shows in the gaps)
    return g;
  })();

  // Pond: 32x32, rounded, lighter ripples, dark bank.
  T.pond = (function () {
    const g = new G(32, 32, '1');
    g.ellipse(16, 16, 15, 13, '3');
    g.ellipse(16, 16, 14, 12, '2');
    g.ellipse(16, 15, 12, 10, '2');
    // ripples
    g.hline(8, 11, 5, '0'); g.hline(14, 12, 3, '0');
    g.hline(18, 17, 6, '0'); g.hline(25, 18, 2, '0');
    g.hline(9, 21, 4, '0'); g.hline(14, 22, 3, '0');
    g.hline(20, 24, 4, '0');
    // reeds on the bank
    g.vline(4, 10, 4, '3'); g.vline(5, 9, 3, '3'); g.set(4, 9, '0');
    g.vline(27, 8, 4, '3'); g.set(27, 7, '0');
    return g;
  })();

  // Barn: 96x64. Dark shingled roof (reads as red), light plank wall, big double doors, loft window.
  T.barn = (function () {
    const g = new G(96, 64, '.');
    // roof body
    g.rect(0, 4, 96, 30, '2');
    g.rect(2, 0, 92, 4, '2');
    for (let y = 8; y < 34; y += 6) g.hline(0, y, 96, '3');      // shingle rows
    for (let y = 8; y < 34; y += 6) for (let x = (Math.floor(y / 6) % 2) * 8 + 4; x < 96; x += 16) g.vline(x, y - 5, 5, '3'); // shingle joints
    g.hline(2, 0, 92, '3'); g.hline(2, 1, 92, '0');               // ridge: outline + light cap
    g.vline(0, 4, 30, '3'); g.vline(95, 4, 30, '3'); g.hline(0, 4, 2, '3'); g.hline(94, 4, 2, '3');
    g.vline(1, 4, 30, '0'); g.vline(2, 2, 2, '0');
    g.vline(93, 2, 2, '3');
    // loft window on the roof (dormer)
    g.rect(40, 10, 16, 14, '3'); g.rect(41, 11, 14, 12, '0');
    g.rect(43, 13, 10, 8, '3'); g.vline(47, 13, 8, '0'); g.vline(48, 13, 8, '0'); g.hline(43, 16, 10, '0'); g.hline(43, 17, 10, '0');
    // eave: light trim then wall
    g.rect(0, 34, 96, 2, '0'); g.hline(0, 36, 96, '3');
    // wall (light with plank lines) x 4..91, y 37..61
    g.rect(4, 36, 88, 26, '0');
    for (let y = 40; y < 62; y += 4) g.hline(5, y, 86, '1');
    g.vline(4, 36, 26, '3'); g.vline(91, 36, 26, '3'); g.hline(4, 61, 88, '3');
    g.rect(0, 36, 4, 26, '.'); g.rect(92, 36, 4, 26, '.');
    g.hline(5, 62, 86, '3'); // ground shadow
    // double doors x 32..63, y 40..61 with X braces
    g.rect(32, 40, 32, 22, '3');
    g.rect(33, 41, 14, 20, '2'); g.rect(49, 41, 14, 20, '2');
    g.line(33, 41, 46, 60, '0'); g.line(46, 41, 33, 60, '0');
    g.line(49, 41, 62, 60, '0'); g.line(62, 41, 49, 60, '0');
    g.hline(33, 41, 30, '0'); g.hline(33, 60, 30, '0');
    g.rect(33, 41, 14, 1, '0'); g.rect(49, 41, 14, 1, '0');
    g.rect(32, 40, 32, 1, '3'); g.vline(47, 40, 22, '3'); g.vline(48, 40, 22, '3');
    // small windows either side
    const win = (x) => { g.rect(x, 42, 10, 10, '3'); g.rect(x + 1, 43, 8, 8, '0'); g.rect(x + 2, 44, 6, 6, '2'); g.vline(x + 5, 44, 6, '3'); g.hline(x + 2, 47, 6, '3'); };
    win(12); win(74);
    return g;
  })();

  // Map legend. Lower-case letters are grass variants, upper-case are things.
  // '.' grass  ',' grass2  '*' flowers  '=' path  'F' fence  'f' fence end  'R' rock
  // 'T' tree  'H' hedge  'G' gate (left half; the right half is implied)  'P' pond (top-left of 2x2)
  // 'B' barn (top-left of 6x4). Blocked for walking: T H F f G P B R and the pond/barn footprints.
  // Top-down logic: pasture at the top, barn mid (doors face down), the fence with its gate below it so the gate
  // sits in front of the barn, and a yard outside the gate where the Shepherd stands. 28x22 tiles: bigger than any
  // phone view at the integer scale rule (portrait ~11x20 tiles, landscape ~22x10), so the camera never shows past
  // an edge. The path runs from the barn doors through the gate into the yard.
  SH.MAP = [
    'TTTTTTTTTTTTTTTTTTTTTTTTTTTT',
    'T.,..*....,.....*..,..*...,T',
    'T.P..,.*......,.R.....,.*..T',
    'T....*.,.....*...,...*.....T',
    'TR..,...,...,..*..,.,.....RT',
    'T,.*.,.T......,..*...*.,...T',
    'T..,..,..*.....,....R......T',
    'T.*..,....,B..........,.*..T',
    'T.,.*.,.................,..T',
    'T,..R...............*......T',
    'T.*..,..............,..*...T',
    'T.....,......==..*..,..T...T',
    'T,.*.........==.......,..*.T',
    'T..,..T......==..*.,......,T',
    'T.*.....,....==.....*..R...T',
    'TFFFFFFFFFFFFGFFFFFFFFFFFFfT',
    'T..,.*.......==..*.,..,....T',
    'T,....,..,...==.....*......T',
    'T.*..,...T...==..,.....,.*.T',
    'T...,......*.==.,.....R....T',
    'T,.*....,....==......,.....T',
    'TTTTTTTTTTTTTTTTTTTTTTTTTTTT',
  ];
  if (SH.MAP.some(row => row.length !== SH.MAP[0].length)) throw new Error('SH.MAP rows differ in width');
  SH.TILE = 16;
  SH.MAP_W = SH.MAP[0].length;
  SH.MAP_H = SH.MAP.length;

  // BFS on the walkability grid; other actors are not obstacles (they pass each other). Returns the tiles to step
  // through (not the start), [] when already there, null when unreachable.
  SH.findPath = function (walk, from, to) {
    const ok = (x, y) => y >= 0 && y < walk.length && x >= 0 && x < walk[0].length && !!walk[y][x];
    if (!ok(to.x, to.y)) return null;
    const key = p => p.x + ',' + p.y, prev = new Map([[key(from), null]]), queue = [from];
    while (queue.length) {
      const p = queue.shift();
      if (p.x === to.x && p.y === to.y) {
        const path = []; let k = key(p), cur = p;
        while (prev.get(k)) { path.unshift(cur); cur = prev.get(k); k = key(cur); }
        return path;
      }
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const n = { x: p.x + dx, y: p.y + dy };
        if (ok(n.x, n.y) && !prev.has(key(n))) { prev.set(key(n), p); queue.push(n); }
      }
    }
    return null;
  };

  // Build the whole map into one Grid, and a walkability grid.
  SH.buildMap = function () {
    const W = SH.MAP_W, H = SH.MAP_H, S = SH.TILE;
    const g = new G(W * S, H * S, '1');
    const walk = [];
    const base = { '.': T.grass, ',': T.grass2, '*': T.flowers, '=': T.path, 'F': T.fence, 'f': T.fenceEnd, 'R': T.rock, 'H': T.stump };
    for (let y = 0; y < H; y++) {
      walk.push([]);
      for (let x = 0; x < W; x++) {
        const c = SH.MAP[y][x];
        const tile = base[c] || T.grass;
        g.stampGrid(tile, x * S, y * S);
        walk[y][x] = !'FfRHTPB'.includes(c);
      }
    }
    // objects (drawn over the grass they sit on)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = SH.MAP[y][x];
      if (c === 'T') g.stampGrid(T.tree, x * S, y * S);
      else if (c === 'G') { g.stampGrid(T.gate, x * S, y * S); walk[y][x + 1] = true; }  // both halves open: the yard reaches the pasture
      else if (c === 'P') { g.stampGrid(T.pond, x * S, y * S); walk[y][x + 1] = walk[y + 1][x] = walk[y + 1][x + 1] = false; }
      else if (c === 'B') {
        g.stampGrid(T.barn, x * S, y * S);
        for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++) walk[y + j][x + i] = false;
      }
    }
    return { grid: g, walk };
  };
})(typeof window !== 'undefined' ? window : globalThis);
