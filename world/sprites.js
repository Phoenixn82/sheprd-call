// Sheprd world: 16x16 character sprites. Shades '0' light .. '3' dark, '.' clear.
// Shepherd: robe 2, outline/hair 3, skin 1, beard 0, crook 3. Sheep: wool 0, face 3, outline 3.
(function (root) {
  'use strict';
  const SH = root.SHEPRD = root.SHEPRD || {};
  const G = SH.Grid;
  const R = rows => G.fromRows(rows);

  const S = SH.SPRITES = {};

  S.shepherd = {};
  S.shepherd.down0 = R([
    '.....33333.33...',
    '....3222223..3..',
    '...333333333.3..',
    '...31111113..3..',
    '...31311313..3..',
    '...31111113..3..',
    '...30000003..3..',
    '....300003...3..',
    '...32222223..3..',
    '..322222222313..',
    '..322111122313..',
    '..3222222223.3..',
    '..3222222223.3..',
    '..3222222223.3..',
    '..3222222223.3..',
    '..3333333333.3..',
  ]);
  S.shepherd.down1 = R([
    '.....33333.33...',
    '....3222223..3..',
    '...333333333.3..',
    '...31111113..3..',
    '...31311313..3..',
    '...31111113..3..',
    '...30000003..3..',
    '....300003...3..',
    '...32222223..3..',
    '..322222222313..',
    '..322111122313..',
    '..3222222223.3..',
    '..3222222223.3..',
    '.32222222223.3..',
    '.32222222223.3..',
    '.33333333333.3..',
  ]);
  S.shepherd.up0 = R([
    '...33..33333....',
    '..3..3322222.3..',
    '..3..3333333333.',
    '..3..32222223...',
    '..3..32222223...',
    '..3..32222223...',
    '..3..32222223...',
    '..3...333333....',
    '..3..32222223...',
    '..313222222223..',
    '..313222222223..',
    '..3.3222222223..',
    '..3.3222222223..',
    '..3.3222222223..',
    '..3.3222222223..',
    '..3.3333333333..',
  ]);
  S.shepherd.up1 = R([
    '...33..33333....',
    '..3..3322222.3..',
    '..3..3333333333.',
    '..3..32222223...',
    '..3..32222223...',
    '..3..32222223...',
    '..3..32222223...',
    '..3...333333....',
    '..3..32222223...',
    '..313222222223..',
    '..313222222223..',
    '..3.3222222223..',
    '..3.3222222223..',
    '..3.32222222223.',
    '..3.32222222223.',
    '..3.33333333333.',
  ]);
  S.shepherd.left0 = R([
    '..33..33333.....',
    '.3..3.3222223...',
    '...33333333333..',
    '....33111333....',
    '....33131333....',
    '....33111333....',
    '....33000333....',
    '....3.30033.....',
    '....33222223....',
    '....332222223...',
    '....312222223...',
    '....331111223...',
    '....332222223...',
    '....332222223...',
    '....332222223...',
    '....333333333...',
  ]);
  S.shepherd.left1 = R([
    '..33..33333.....',
    '.3..3.3222223...',
    '...33333333333..',
    '....33111333....',
    '....33131333....',
    '....33111333....',
    '....33000333....',
    '....3.30033.....',
    '....33222223....',
    '....332222223...',
    '....312222223...',
    '....331111223...',
    '....332222223...',
    '....3322222223..',
    '....3322222223..',
    '....3333333333..',
  ]);
  S.shepherd.right0 = S.shepherd.left0.flipX();
  S.shepherd.right1 = S.shepherd.left1.flipX();

  // Sheep as small dark rams (his words, 2026-11-06: "match the look of the herder logo ... the horn ... still
  // obviously low quality video game looking"): dark head in profile with a light spiral horn curling at the back,
  // a light ">" prompt for the eye, a lumpy wool body, two legs. Drawn here, not traced.
  S.sheep = {};
  S.sheep.left0 = R([ // head up
    '................',
    '......333..33...',
    '...33000333333..',
    '..3303330333333.',
    '.333030033333333',
    '.303033033333333',
    '3330300333333333',
    '3303333333323333',
    '.33333333333333.',
    '..333322333323..',
    '...33333333333..',
    '....333333333...',
    '....33....33....',
    '....33....33....',
    '................',
    '................',
  ]);
  // Grazing: the head (x 0..7, the rows above the legs) drops two rows; the body and legs stay.
  S.sheep.left1 = (function () {
    const g = S.sheep.left0.clone();
    for (let y = 0; y < 12; y++) for (let x = 0; x <= 7; x++) g.set(x, y, y >= 2 ? S.sheep.left0.get(x, y - 2) : '.');
    return g;
  })();
  S.sheep.right0 = S.sheep.left0.flipX();
  S.sheep.right1 = S.sheep.left1.flipX();

  // Hats (his words, 2026-11-06: "apply to the sheep like hats and to the shepherd as well"; the Shepherd's wide
  // brim is drawn into his frames above). A sheep's hat is 8x3 over the head top (x 3; y 0, or 2 while it grazes and
  // the head is down), picked from its pane id so a tab keeps its hat. '.' is clear.
  SH.HATS = {
    cap: ['..33333.', '33000003', '........'],
    pot: ['..30003.', '..30003.', '.3333333'],
    cone: ['.....3..', '....303.', '...30003'],
    crown: ['.3.3.3.3', '.3000003', '........'],
    beanie: ['...333..', '..32223.', '.3222223'],
    bucket: ['..33333.', '..32223.', '.3333333'],
  };
  SH.HAT_NAMES = Object.keys(SH.HATS);
  SH.sheepFrames = function (hat) {
    const rows = SH.HATS[hat];
    const left0 = S.sheep.left0.clone(), left1 = S.sheep.left1.clone();
    if (rows) { left0.stamp(rows, 3, 0); left1.stamp(rows, 3, 2); }
    return { left0, left1, right0: left0.flipX(), right1: left1.flipX() };
  };
  SH.hatFor = function (id) {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return SH.HAT_NAMES[h % SH.HAT_NAMES.length];
  };

  // "!" balloon above a sheep that needs the owner. 8x10.
  S.balloon = R([
    '.333333.',
    '30000003',
    '30033003',
    '30033003',
    '30033003',
    '30000003',
    '30033003',
    '30000003',
    '.333333.',
    '..3.....',
  ]);
  // Check balloon above a sheep that is done. 8x10.
  S.check = R([
    '.333333.',
    '30000003',
    '30000303',
    '30003003',
    '33030003',
    '30300003',
    '30000003',
    '.333333.',
    '..3.....',
    '........',
  ]);
  // "..." balloon: the +N more-sheep sign and a sheep's tag. 14x10.
  S.dots = R([
    '.333333333333.',
    '30000000000003',
    '30000000000003',
    '30330330330003',
    '30330330330003',
    '30000000000003',
    '.333333333333.',
    '..3...........',
    '..............',
    '..............',
  ]);

  // A picture box on a tripod by the yard: tap it to add a photo or video (2026-11-06: "there shouldn't be really
  // any buttons ... find unique ways to incorporate the buttons as features"). 16x16.
  S.camera = R([
    '................',
    '................',
    '....33333333....',
    '...3300000033...',
    '...3022222203...',
    '...3023333203...',
    '...3023003203...',
    '...3023003203...',
    '...3023333203...',
    '...3022222203...',
    '...3300000033...',
    '....33333333....',
    '......3..3......',
    '.....3....3.....',
    '....3......3....',
    '................',
  ]);

  // Dialogue advance marker (blinks). 5x3.
  S.advance = R(['33333', '.333.', '..3..']);

  // A wooden sign: light board with dark 3x5 text and a 1px border, on a two-pixel post. The yard's sign says how many
  // more sheep there are than the world places; the PLAY sign opens the games.
  SH.signGrid = function (text) {
    const t = SH.textGrid(text, 'tag', '3');
    const w = t.w + 6, h = t.h + 4;
    const g = new G(w, h + 4, '.');
    g.rect(0, 0, w, h, '3'); g.rect(1, 1, w - 2, h - 2, '0');
    g.stampGrid(t, 3, 2);
    const px = Math.floor(w / 2) - 1;
    g.rect(px, h, 2, 4, '3'); g.set(px, h, '2'); g.set(px, h + 1, '2');
    return g;
  };

  // Name tag: dark box, light 3x5 text, 1px padding.
  SH.tagGrid = function (name) {
    const t = SH.textGrid(name, 'tag', '0');
    const g = new G(t.w + 4, t.h + 4, '3');
    g.stampGrid(t, 2, 2);
    // soften corners
    g.set(0, 0, '.'); g.set(g.w - 1, 0, '.'); g.set(0, g.h - 1, '.'); g.set(g.w - 1, g.h - 1, '.');
    return g;
  };
})(typeof window !== 'undefined' ? window : globalThis);
