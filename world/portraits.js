// Sheprd world: 80x80 dialogue portraits, 6 shades ('0' light .. '5' dark).
// Each character = a cached base (hair, face, beard, robe) + swappable feature layers
// (eyes, brows, mouth, hand, extras) stamped at fixed anchors. Add an expression by
// naming a combination in EXPR; add a feature variant by adding a stamp.
(function (root) {
  'use strict';
  const SH = root.SHEPRD = root.SHEPRD || {};
  const G = SH.Grid;
  const W = 80, H = 80;

  // ---------- Shepherd feature stamps (left side; the right side is mirrored) ----------
  // Eye 12x8, anchor L (26,33) / R mirrored (42,33).
  const EYES = {
    neutral: [
      '...555555...',
      '.5500000055.',
      '500044440005',
      '500040540005',
      '500045540005',
      '.5500444455.',
      '..22222222..',
      '............'],
    up: [ // looking up and away (thinking); not mirrored so both look the same way
      '...555555...',
      '.5504444055.',
      '500040540005',
      '500045540005',
      '.5500000055.',
      '..55555555..',
      '............',
      '............'],
    wide: [
      '..55555555..',
      '.5000000005.',
      '500000000005',
      '500044440005',
      '500045540005',
      '500044440005',
      '.5000000005.',
      '..55555555..'],
    happy: [
      '............',
      '....5555....',
      '..55555555..',
      '.555....555.',
      '55........55',
      '............',
      '............',
      '............'],
    wince: [ // tense: lower lid pushed up over the iris
      '...555555...',
      '.5500000055.',
      '500044440005',
      '500040540005',
      '.5555555555.',
      '..22222222..',
      '............',
      '............'],
  };
  // Brows: polyline through three points for the LEFT brow (outer, mid, inner), 2px thick.
  const BROWS = {
    neutral: [[25, 30], [31, 27], [37, 28]],
    furrowed: [[25, 28], [31, 27], [37, 31]],
    raised: [[25, 27], [31, 23], [37, 25]],
    worried: [[25, 31], [31, 29], [37, 26]],
    happy: [[25, 28], [31, 25], [37, 26]],
  };
  // Mouth 18x7, anchor (31,51), stamped over the beard. '.' keeps the beard.
  const MOUTHS = {
    closed: [
      '..................',
      '...55555555555....',
      '....2222222222....',
      '..................',
      '..................',
      '..................',
      '..................'],
    small: [
      '....5555555555....',
      '...50000000005....',
      '...55555555555....',
      '....2222222222....',
      '..................',
      '..................',
      '..................'],
    open: [
      '.....55555555.....',
      '...550000000055...',
      '..55555555555555..',
      '..55555555555555..',
      '...553333333355...',
      '....5555555555....',
      '.....22222222.....'],
    o: [
      '......555555......',
      '....5500000055....',
      '...555555555555...',
      '...555533335555...',
      '....5555555555....',
      '.....22222222.....',
      '..................'],
    grin: [
      '55..............55',
      '.55............55.',
      '..55000000000055..',
      '...500100100105...',
      '...555555555555...',
      '....2222222222....',
      '..................'],
    frown: [
      '......555555......',
      '....555....555....',
      '...55........55...',
      '..5............5..',
      '..................',
      '..................',
      '..................'],
  };
  const SWEAT = ['..5..', '.505.', '.505.', '50005', '50005', '50005', '.555.'];

  function thickPolyline(g, pts, v, mirror) {
    const P = pts.map(([x, y]) => [mirror ? 79 - x : x, y]);
    for (let i = 0; i + 1 < P.length; i++) {
      g.line(P[i][0], P[i][1], P[i + 1][0], P[i + 1][1], v);
      g.line(P[i][0], P[i][1] + 1, P[i + 1][0], P[i + 1][1] + 1, v);
    }
  }

  // Hand resting at the chin (thinking). Built in its own grid so it gets a clean outline.
  // Hand stroking the beard (thinking): four fingers laid leftward across the lower beard,
  // back of the hand to the right, sleeve running off the bottom-right.
  function handGrid() {
    const g = new G(46, 30);
    g.ellipse(26, 10, 9, 9, '1');                                   // back of hand
    const len = [15, 17, 16, 13];                                   // index .. little finger
    for (let i = 0; i < 4; i++) {
      const y = 2 + i * 4, x0 = 22 - len[i];
      g.rect(x0, y, len[i], 3, '1'); g.ellipse(x0, y + 1, 1.5, 1.5, '1');
    }
    for (let y = 16; y < 30; y++) g.hline(22 + Math.floor((y - 16) * 0.8), y, 24, '1'); // sleeve
    g.outline('5');
    for (let i = 0; i < 4; i++) g.hline(21, 3 + i * 4, 3, '2');    // knuckles
    for (let y = 16; y < 30; y++) { g.set(22 + Math.floor((y - 16) * 0.8), y, '5'); g.set(23 + Math.floor((y - 16) * 0.8), y, '2'); } // cuff
    return g;
  }
  const HAND = handGrid();

  function shepherdBase() {
    const f = new G(W, H); // figure on transparent, outlined later
    // robe + shoulders
    f.ellipse(40, 74, 35, 11, '1'); f.rect(5, 70, 70, 10, '1');
    f.hline(5, 79, 70, '1');
    // neck
    f.rect(33, 52, 14, 14, '1'); f.rect(33, 52, 14, 5, '2');
    // hair back and side falls
    f.ellipse(40, 34, 22, 22, '4');
    f.rect(18, 34, 7, 30, '4'); f.rect(55, 34, 7, 30, '4');
    f.ellipse(21, 63, 4, 4, '4'); f.ellipse(58, 63, 4, 4, '4');
    // face with a shadow crescent on the right
    f.ellipse(41, 38, 16, 19, '2');
    f.ellipse(39, 38, 15, 18, '1');
    f.rect(24, 30, 3, 14, '1');
    // hair front lobes with a centre parting
    f.ellipse(29, 21, 10, 7, '4'); f.ellipse(51, 21, 10, 7, '4');
    f.vline(40, 14, 7, '3');
    f.line(31, 16, 24, 24, '3'); f.line(49, 16, 56, 24, '3'); // strand highlights
    f.line(35, 15, 29, 25, '3'); f.line(45, 15, 51, 25, '3');
    f.line(20, 40, 20, 58, '3'); f.line(60, 40, 60, 58, '3');  // side-fall strands
    // beard: jaw wedges + main mass, skin kept under the nose, mustache
    f.ellipse(27, 50, 4, 8, '3'); f.ellipse(53, 50, 4, 8, '3');
    f.ellipse(40, 56, 15, 11, '3');
    f.ellipse(40, 44, 9, 4, '1');
    f.ellipse(34, 48, 6, 2.5, '3'); f.ellipse(46, 48, 6, 2.5, '3');
    f.set(40, 48, '1'); f.set(40, 49, '1');
    // beard texture
    for (const [x, y, l] of [[30, 56, 5], [34, 60, 4], [40, 62, 5], [46, 60, 4], [50, 56, 5], [27, 52, 3], [53, 52, 3]]) f.vline(x, y, l, '4');
    for (const [x, y, l] of [[32, 54, 3], [48, 54, 3], [37, 58, 3], [43, 58, 3]]) f.vline(x, y, l, '2');
    // nose
    f.stamp([
      '....2....',
      '....2....',
      '...2.....',
      '...2.....',
      '...2.....',
      '..2......',
      '..2......',
      '.2.......',
      '.55...55.',
      '..55555..'], 36, 36);
    // ears peeking from the hair
    f.ellipse(23, 40, 2.5, 4, '1'); f.ellipse(57, 40, 2.5, 4, '1');
    f.outline('5');
    // collar: V neckline
    f.line(33, 66, 40, 73, '5'); f.line(47, 66, 40, 73, '5');
    f.line(32, 66, 39, 73, '2'); f.line(48, 66, 41, 73, '2');
    f.hline(26, 66, 7, '5'); f.hline(47, 66, 8, '5');
    f.line(18, 66, 12, 79, '2'); f.line(62, 66, 68, 79, '2'); // folds
    // sash
    f.line(26, 67, 40, 79, '3'); f.line(27, 67, 41, 79, '3');
    // composite on the background
    const g = new G(W, H, '2');
    g.stampGrid(f, 0, 0);
    return g;
  }

  // ---------- Sheep: a dark ram in profile (his words, 2026-11-06: "match the look of the herder logo") ----------
  // Dark head facing left, a light spiral horn curling at the back of the head, a ">_" prompt for the eye, a lumpy
  // wool body along the bottom. Own drawing in the 6 shades, not the logo's file.
  function sheepBase() {
    const f = new G(W, H);
    // wool body: a wide cloud of lumps spilling off the bottom and right edges
    f.ellipse(56, 74, 40, 18, '4');
    for (const [x, y, r] of [[18, 66, 9], [30, 60, 10], [44, 56, 10], [58, 54, 11], [72, 58, 10], [82, 66, 9], [8, 74, 8]]) f.ellipse(x, y, r, r, '4');
    f.rect(0, 70, 80, 10, '4');
    // neck up into the head, head in profile, muzzle to the lower left
    f.rect(40, 36, 26, 36, '4');
    f.ellipse(40, 32, 21, 17, '4');
    f.ellipse(20, 42, 13, 9, '4');
    f.rect(20, 34, 22, 14, '4');
    // the horn: a thick light spiral behind the eye. Outer ring open at the lower left, inner curl.
    const cx = 50, cy = 29;
    for (let y = cy - 18; y <= cy + 18; y++) for (let x = cx - 18; x <= cx + 18; x++) {
      const dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy), a = Math.atan2(dy, dx) * 180 / Math.PI;
      const gap = a > 110 && a < 200; // the opening of the outer ring (lower left, toward the eye)
      if ((r >= 11 && r <= 17 && !gap) || (r >= 3 && r <= 6.5 && !(a > 60 && a < 150))) f.set(x, y, '0');
    }
    f.rect(cx - 18, cy + 2, 8, 6, '0'); // the outer ring's tail runs forward into the brow
    f.outline('5');
    // light rim where the horn meets the dark head so the curl reads at a glance
    f.edge('0', '1');
    // nostril and ear
    f.set(9, 41, '0'); f.set(10, 41, '0');
    f.ellipse(62, 14, 7, 4, '4'); f.ellipse(62, 14, 4, 2, '5');
    const g = new G(W, H, '2');
    g.stampGrid(f, 0, 0);
    return g;
  }
  // The eye is a terminal prompt: ">" plus a cursor that changes with the mood. Anchor (22,29), light on the dark head.
  const SHEEP_EYES = { // the ">" (3 px strokes); happy is a smaller, raised chevron
    neutral: ['555........', '.555.......', '..555......', '...555.....', '....555....', '...555.....', '..555......', '.555.......', '555........'],
    happy: ['...........', '...........', '555........', '.555.......', '..555......', '.555.......', '555........', '...........', '...........'],
    wide: ['555........', '.555.......', '..555......', '...555.....', '....555....', '...555.....', '..555......', '.555.......', '555........'],
  };
  const SHEEP_CURSORS = { // anchor (31,30): the cursor after the ">"
    neutral: ['........', '........', '........', '........', '........', '........', '........', '0000000.', '0000000.'],
    happy: ['........', '........', '........', '........', '00....00', '00....00', '.00..00.', '..0000..', '........'],
    wide: ['0000000.', '0000000.', '0000000.', '0000000.', '0000000.', '0000000.', '0000000.', '0000000.', '0000000.'],
  };
  const SHEEP_MOUTHS = { // anchor (11,45) on the muzzle
    neutral: ['00000000', '........', '........', '........'],
    smile: ['00.....0', '.00...0.', '..0000..', '........'],
    o: ['..000...', '.0...0..', '.0...0..', '..000...'],
  };

  // ---------- Expressions ----------
  const EXPR = {
    shepherd: {
      neutral: { eyes: 'neutral', brows: 'neutral', mouth: 'closed' },
      talk1: { eyes: 'neutral', brows: 'neutral', mouth: 'small' },
      talk2: { eyes: 'neutral', brows: 'neutral', mouth: 'open' },
      thinking: { eyes: 'up', brows: 'furrowed', mouth: 'closed', hand: true, noMirror: true },
      surprised: { eyes: 'wide', brows: 'raised', mouth: 'o' },
      happy: { eyes: 'happy', brows: 'happy', mouth: 'grin' },
      worried: { eyes: 'wince', brows: 'worried', mouth: 'frown', sweat: true },
    },
    sheep: {
      neutral: { eyes: 'neutral', mouth: 'neutral' },
      happy: { eyes: 'happy', mouth: 'smile' },
      alert: { eyes: 'wide', mouth: 'o', bang: true },
    },
  };

  const cache = {};
  function base(who) { return cache[who] || (cache[who] = who === 'sheep' ? sheepBase() : shepherdBase()); }

  function renderShepherd(e) {
    const g = base('shepherd').clone();
    const L = G.fromRows(EYES[e.eyes]);
    g.stampGrid(L, 26, 33);
    g.stampGrid(e.noMirror ? L : L.flipX(), 42, 33);
    thickPolyline(g, BROWS[e.brows], '5', false);
    thickPolyline(g, BROWS[e.brows], '5', true);
    g.stamp(MOUTHS[e.mouth], 31, 51);
    if (e.hand) g.stampGrid(HAND, 28, 61);
    if (e.sweat) g.stamp(SWEAT, 60, 18);
    return g;
  }
  function renderSheep(e) {
    const g = base('sheep').clone();
    g.stamp(SHEEP_EYES[e.eyes], 22, 29, { '5': '0' });
    g.stamp(SHEEP_CURSORS[e.eyes], 31, 30);
    g.stamp(SHEEP_MOUTHS[e.mouth], 11, 45);
    if (e.bang) g.stamp(['.55.', '5005', '5005', '5005', '5005', '.55.', '....', '.55.', '.55.'], 4, 6);
    return g;
  }

  SH.PORTRAITS = {
    EXPR,
    list() {
      const out = [];
      for (const who in EXPR) for (const n in EXPR[who]) out.push(who + '-' + n);
      return out;
    },
    render(name) {
      const [who, expr] = name.split('-');
      const e = (EXPR[who] || EXPR.shepherd)[expr] || EXPR[who === 'sheep' ? 'sheep' : 'shepherd'].neutral;
      return who === 'sheep' ? renderSheep(e) : renderShepherd(e);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
