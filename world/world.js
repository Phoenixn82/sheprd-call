// Sheprd world: the Phaser scene behind the call screen. Exposes window.SheprdWorld.mount(el, opts) -> world with
// setHerd(layout), setSprite(state), setProps(list), setMark(kind | null), resize(). The page owns all the
// logic (call, herd, the text thread, what a prop does); this file only draws what it is told and reports taps through
// the callbacks in opts (onSheep, onShepherd, onMore, onProp, onGround).
//
// Scale: the largest integer scale in device pixels that fits a 160x144 base (expressed as a zoom of n / dpr), and the
// logical viewport is floor(device px / n) in both axes, so the world fills whatever area it is given. The map is
// bigger than any such view (the scale is raised if it is not), so the camera never shows past an edge.
(function () {
  'use strict';
  const SH = window.SHEPRD;
  const T = SH.TILE, MIN_W = 160, MIN_H = 144, MAP_PX_W = SH.MAP_W * T, MAP_PX_H = SH.MAP_H * T;
  const HERO_SPEED = 48, SHEEP_SPEED = 32;

  // Tiles the herd stands on, per zone. The field has a set per orientation (a phone's portrait view is a tall column
  // around the barn; its landscape view a wide band), so rotating the phone walks the grazing sheep into view.
  const SPOTS = {
    field: {
      portrait: [[10, 4], [13, 3], [16, 4], [11, 6], [15, 6], [9, 8], [17, 8], [13, 5]],
      landscape: [[7, 9], [5, 11], [7, 12], [20, 9], [22, 11], [20, 12], [4, 13], [21, 13]],
    },
    gate: [[11, 14], [16, 14], [10, 13], [17, 13], [12, 13], [15, 13], [9, 14], [18, 14]],
    home: [[13, 12], [14, 11], [12, 11], [15, 12], [11, 12], [16, 11], [17, 12], [18, 11]],
    // resting (idle) sheep: beside the barn's walls in portrait; in landscape the barn is above the view, so they lie
    // in the pasture just inside the fence
    rest: {
      portrait: [[10, 10], [17, 10], [10, 9], [17, 9], [9, 10], [18, 10], [9, 9], [18, 9]],
      landscape: [[3, 14], [8, 14], [19, 14], [24, 14], [4, 13], [9, 13], [18, 13], [22, 13]],
    },
    hero: [13, 16], aside: [7, 17], spawn: [13, 11], moreSign: [17, 16],
  };

  function fit(el) {
    const dpr = window.devicePixelRatio || 1;
    const dw = Math.max(1, el.clientWidth) * dpr, dh = Math.max(1, el.clientHeight) * dpr;
    let n = Math.max(1, Math.floor(Math.min(dw / MIN_W, dh / MIN_H)));
    n = Math.max(n, Math.ceil(dw / MAP_PX_W), Math.ceil(dh / MAP_PX_H)); // never wider or taller than the map
    return { n, zoom: n / dpr, w: Math.max(1, Math.floor(dw / n)), h: Math.max(1, Math.floor(dh / n)) };
  }

  // The page's overlay controls cover part of the canvas (landscape: the key strip and the text box), given in css
  // px; converted here with the zoom of the size being laid out, never a stale one.
  function layout(el, css) {
    const f = fit(el), c = css || {};
    f.insets = { right: Math.max(0, Math.ceil((+c.right || 0) / f.zoom)), bottom: Math.max(0, Math.ceil((+c.bottom || 0) / f.zoom)) };
    return f;
  }

  function addTex(scene, key, grid, palette) {
    if (scene.textures.exists(key)) return scene.textures.get(key);
    return scene.textures.addCanvas(key, SH.gridToCanvas(grid, palette));
  }
  function addSheet(scene, key, named, palette) {
    const s = SH.strip(named);
    const t = addTex(scene, key, s.grid, palette);
    for (const n in s.frames) { const f = s.frames[n]; t.add(n, 0, f.x, f.y, f.w, f.h); }
    return t;
  }
  const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];

  class World extends Phaser.Scene {
    constructor(store) { super('world'); this.store = store; }

    create() {
      const S = this.store, REDUCED = S.opts.reducedMotion;
      const map = SH.buildMap();
      this.walk = map.walk;
      this.walk[SPOTS.moreSign[1]][SPOTS.moreSign[0]] = false;
      addTex(this, 'map', map.grid);
      this.add.image(0, 0, 'map').setOrigin(0, 0);

      const sp = SH.SPRITES;
      addSheet(this, 'shepherd', sp.shepherd);
      for (const h of SH.HAT_NAMES) addSheet(this, 'sheep-' + h, SH.sheepFrames(h));  // one sheet per hat
      addTex(this, 'balloon', sp.balloon); addTex(this, 'check', sp.check); addTex(this, 'dots', sp.dots);
      for (const dir of ['down', 'up', 'left', 'right']) {
        this.anims.create({ key: 'walk-' + dir, frames: [{ key: 'shepherd', frame: dir + '0' }, { key: 'shepherd', frame: dir + '1' }], frameRate: 6, repeat: -1 });
      }

      // The Shepherd
      const [hx, hy] = SPOTS.hero;
      this.hero = this.add.sprite(hx * T + 8, hy * T + 8, 'shepherd', 'down0');
      Object.assign(this.hero, { tx: hx, ty: hy, dir: 'down', path: [], speed: HERO_SPEED, bob: 0, sprite: this.hero });  // an actor like the sheep: step() and send() move a.sprite
      this.heroMark = this.add.image(this.hero.x, this.hero.y - 14, 'balloon').setOrigin(0.5, 1).setDepth(5002).setVisible(false);  // "!" while something waits on him
      this.props = new Map();
      this.anchor = { x: this.hero.x, y: this.hero.y };

      // Signs
      this.moreSign = this.add.image(SPOTS.moreSign[0] * T + 8, SPOTS.moreSign[1] * T + 16, 'dots').setOrigin(0.5, 1).setVisible(false);
      this.moreSign.setDepth(this.moreSign.y);

      this.sheep = new Map();
      this.tick = 0;
      if (!REDUCED) this.time.addEvent({ delay: 700, loop: true, callback: () => { this.tick++; this.sheep.forEach(a => { if (!a.path.length && !a.gone) a.sprite.setFrame(a.dir + (((this.tick + a.phase) % 3 === 0) ? '1' : '0')); }); } });

      const cam = this.cameras.main;
      cam.setBounds(0, 0, MAP_PX_W, MAP_PX_H);
      cam.setRoundPixels(true);

      this.input.on('pointerdown', p => this.onPointer(p));

      this.ready = true;
      this.onResize();
      this.applyHerd(); this.applySprite(); this.applyProps(); this.applyMark();
      this.sortDepth();
      this.snapCamera();
    }

    // ---------- geometry ----------
    walkable(x, y) { return y >= 0 && y < this.walk.length && x >= 0 && x < this.walk[0].length && this.walk[y][x]; }
    findPath(from, to) { return SH.findPath(this.walk, from, to); }
    // Move an actor along its path; returns true while it is still walking.
    step(a, delta, onFrame) {
      if (!a.path.length) return false;
      const next = a.path[0], gx = next.x * T + 8, gy = next.y * T + 8, dx = gx - a.sprite.x, dy = gy - a.sprite.y;
      a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      onFrame(a);
      const s = a.speed * delta / 1000;
      if (Math.abs(dx) <= s && Math.abs(dy) <= s) { a.sprite.x = gx; a.sprite.y = gy; a.tx = next.x; a.ty = next.y; a.path.shift(); }
      else { a.sprite.x += Math.sign(dx) * Math.min(s, Math.abs(dx)); a.sprite.y += Math.sign(dy) * Math.min(s, Math.abs(dy)); }
      return a.path.length > 0;
    }
    send(a, tile, instant) {
      if (a.tx === tile[0] && a.ty === tile[1] && !a.path.length) return;
      if (instant || this.store.opts.reducedMotion) { a.path = []; a.tx = tile[0]; a.ty = tile[1]; a.sprite.x = tile[0] * T + 8; a.sprite.y = tile[1] * T + 8; return; }
      const path = this.findPath({ x: a.tx, y: a.ty }, { x: tile[0], y: tile[1] });
      if (path) a.path = path;  // unreachable: stay put (never teleport)
    }
    sortDepth() {
      this.hero.setDepth(Math.round(this.hero.y));
      this.sheep.forEach(a => a.sprite.setDepth(Math.round(a.sprite.y)));
    }
    orientation() { return this.scale.width >= this.scale.height ? 'landscape' : 'portrait'; }

    // ---------- herd ----------
    applyHerd() {
      const L = this.store.herd; if (!L || !this.ready) return;
      const S = this.store, REDUCED = S.opts.reducedMotion;
      const want = new Map();
      const zones = [['field', SPOTS.field[this.orientation()]], ['gate', SPOTS.gate], ['home', SPOTS.home], ['rest', SPOTS.rest[this.orientation()]]];
      for (const [zone, spots] of zones) (L[zone] || []).forEach((s, i) => { if (spots[i]) want.set(s.id, { ...s, zone, tile: spots[i] }); });
      // gone sheep fade (or vanish under reduced motion)
      this.sheep.forEach((a, id) => {
        if (want.has(id) || a.gone) return;
        a.gone = true; a.path = []; a.tag.setVisible(false); if (a.balloon) a.balloon.setVisible(false);
        const drop = () => { a.sprite.destroy(); a.tag.destroy(); if (a.balloon) a.balloon.destroy(); this.sheep.delete(id); };
        if (REDUCED) drop(); else this.tweens.add({ targets: a.sprite, alpha: 0, duration: 600, onComplete: drop });
      });
      want.forEach((w, id) => {
        let a = this.sheep.get(id);
        if (a && a.gone) { a = null; }
        if (!a) {
          const [sx, sy] = REDUCED ? w.tile : SPOTS.spawn;
          const spr = this.add.sprite(sx * T + 8, sy * T + 8, 'sheep-' + SH.hatFor(id), 'left0');
          a = { id, sprite: spr, tx: sx, ty: sy, dir: 'left', path: [], speed: SHEEP_SPEED, phase: this.sheep.size, tagName: null, balloon: null, kind: null };
          a.tag = this.add.image(spr.x, spr.y - 12, 'dots').setDepth(5000);
          this.sheep.set(id, a);
        }
        if (a.tagName !== w.name) {
          const key = 'tag-' + id + '-' + w.name;
          addTex(this, key, SH.tagGrid(w.name)); a.tag.setTexture(key); a.tagName = w.name;
        }
        const kind = w.zone === 'gate' ? 'balloon' : w.zone === 'home' ? 'check' : null;
        if (kind !== a.kind) {
          if (a.balloon) { a.balloon.destroy(); a.balloon = null; }
          if (kind) a.balloon = this.add.image(a.sprite.x, a.sprite.y - 22, kind).setDepth(5001);
          a.kind = kind;
        }
        a.zone = w.zone;
        this.send(a, w.tile);
        if (!a.path.length) a.dir = w.tile[0] >= 14 ? 'left' : 'right';
      });
      this.sheep.forEach(a => this.placeTag(a));
      this.declutter();
      const more = L.more || 0;
      this.setSign(this.moreSign, more ? '+' + more + ' more' : null);
      this.showTags(true);
      this.sortDepth();
    }
    setSign(img, text) {
      if (!text) { img.setVisible(false); img.text = null; return; }
      if (img.text !== text) { const key = 'sign-' + text; addTex(this, key, SH.signGrid(text)); img.setTexture(key); img.text = text; }
      img.setVisible(true);
    }
    placeTag(a) {
      a.tag.setPosition(Math.round(a.sprite.x), Math.round(a.sprite.y - 14));  // 2 px higher than bare: room for the hat
    }
    // Two sheep close together: lift the lower tag's neighbour above it so both names stay readable (n <= 8); each
    // balloon (! or check) then sits on its own tag, never across a name.
    declutter() {
      const live = [...this.sheep.values()].filter(a => !a.gone);
      live.forEach(a => this.placeTag(a));  // from scratch: a tag lifted for a sheep that has since walked on comes back
      const tags = live.map(a => a.tag).sort((a, b) => b.y - a.y);
      tags.forEach((t, i) => {
        for (const o of tags.slice(0, i)) {
          if (Math.abs(t.x - o.x) < (t.width + o.width) / 2 + 1 && Math.abs(t.y - o.y) < t.height + 1) t.y = o.y - t.height - 1;
        }
      });
      const view = this.cameras.main.worldView;  // a long name near the edge stays on screen
      for (const t of tags) t.x = Math.round(Math.min(Math.max(t.x, view.x + t.width / 2 + 1), view.right - t.width / 2 - 1));
      for (const a of live) if (a.balloon) a.balloon.setPosition(a.tag.x, Math.round(a.tag.y - (a.tag.height + a.balloon.height) / 2 - 1));
    }
    showTags(on) { this.sheep.forEach(a => { if (a.gone) return; a.tag.setVisible(on); if (a.balloon) a.balloon.setVisible(on); }); }

    // ---------- the Shepherd ----------
    applySprite() {
      if (!this.ready) return;
      const { state } = this.store.sprite, h = this.hero;
      if (state !== this.heroState) {
        this.heroState = state;
        if (state === 'aside') this.send(h, SPOTS.aside);
        else if (this.wasAside) this.send(h, SPOTS.hero);
        else if (state !== 'idle') { h.path = []; }
        this.wasAside = state === 'aside';
        h.bob = 0; h.y = h.ty * T + 8 + (h.path.length ? h.y - (h.ty * T + 8) : 0);
      }
    }
    heroFrame(h) {
      if (h.path.length) { if (!h.anims.isPlaying || h.anims.currentAnim.key !== 'walk-' + h.dir) h.play('walk-' + h.dir); return; }
      if (h.anims.isPlaying) h.stop();
      const s = this.heroState;
      const dir = s === 'listening' || s === 'thinking' || s === 'talking' ? 'down' : s === 'aside' ? 'up' : h.dir;
      h.dir = dir; h.setFrame(dir + '0');
    }

    // ---------- props: in-world controls the page registers (a picture box for photos, ...) ----------
    applyProps() {
      if (!this.ready) return;
      for (const p of this.store.props || []) {
        if (this.props.has(p.id)) continue;
        addTex(this, 'prop-' + p.id, SH.Grid.fromRows(p.rows));
        const img = this.add.image(p.tile[0] * T + 8, p.tile[1] * T + 8, 'prop-' + p.id);
        img.setDepth(img.y);
        this.props.set(p.id, img);
      }
    }
    applyMark() { if (this.ready) this.heroMark.setVisible(!!this.store.mark); }

    // ---------- camera ----------
    camTarget() {
      const W = this.scale.width, H = this.scale.height, a = this.anchor;
      return { x: Phaser.Math.Clamp(a.x - W / 2, 0, MAP_PX_W - W), y: Phaser.Math.Clamp(a.y - H * 0.85, 0, MAP_PX_H - H) };
    }
    snapCamera() { const t = this.camTarget(); this.cameras.main.setScroll(t.x, t.y); }
    followHero(instant) {
      const h = this.hero, a = this.anchor;
      if (h.x - a.x > 40) a.x = h.x - 40; else if (a.x - h.x > 40) a.x = h.x + 40;
      if (h.y - a.y > 24) a.y = h.y - 24; else if (a.y - h.y > 24) a.y = h.y + 24;
      const cam = this.cameras.main, t = this.camTarget();
      if (instant || this.store.opts.reducedMotion) cam.setScroll(t.x, t.y);
      else cam.setScroll(cam.scrollX + (t.x - cam.scrollX) * 0.12, cam.scrollY + (t.y - cam.scrollY) * 0.12);
    }

    update(time, delta) {
      if (!this.ready) return;
      const h = this.hero, REDUCED = this.store.opts.reducedMotion;
      const walking = this.step(h, delta, a => this.heroFrame(a));
      if (!walking) this.heroFrame(h);
      if (this.heroState === 'talking' && !walking && !REDUCED) h.y = h.ty * T + 8 - (Math.floor(time / 180) % 2);
      this.heroMark.setPosition(Math.round(h.x), Math.round(h.y) - 10);
      let moved = walking;
      this.sheep.forEach(a => {
        if (a.gone) return;
        // the sheep sheet has only left and right: a vertical leg keeps the last sideways facing
        const face = s => { if (s.dir === 'left' || s.dir === 'right') s.face = s.dir; return s.face || 'left'; };
        if (this.step(a, delta, s => { s.sprite.setFrame(face(s) + (Math.floor(time / 160) % 2)); })) { moved = true; this.placeTag(a); }
        else if (face(a) !== a.sprite.frame.name.replace(/[01]$/, '')) a.sprite.setFrame(face(a) + '0');
      });
      if (moved) { this.declutter(); this.sortDepth(); }
      this.followHero(false);
    }

    // ---------- input ----------
    onPointer(p) {
      const S = this.store, cb = S.opts;
      const near = (spr, r) => Math.abs(p.worldX - spr.x) <= r && Math.abs(p.worldY - spr.y) <= r;
      // one generous tap: the sheep or its name tag
      const onSheep = a => Math.abs(p.worldX - a.sprite.x) <= Math.max(12, a.tag.width / 2 + 2)
        && p.worldY >= a.sprite.y - 20 && p.worldY <= a.sprite.y + 10;
      for (const [id, a] of this.sheep) if (!a.gone && onSheep(a)) { cb.onSheep && cb.onSheep(id); return; }
      if (near(this.hero, 9)) { cb.onShepherd && cb.onShepherd(); return; }
      for (const [id, img] of this.props) if (near(img, 10)) { cb.onProp && cb.onProp(id); return; }
      const onSign = img => img.visible && Math.abs(p.worldX - img.x) <= img.width / 2 + 2 && p.worldY <= img.y + 2 && p.worldY >= img.y - img.height - 2;
      if (onSign(this.moreSign)) { cb.onMore && cb.onMore(); return; }
      cb.onGround && cb.onGround();  // the ground does nothing: he found walking the Shepherd around annoying
    }

    onResize() {
      if (!this.ready) return;
      const W = this.scale.width, H = this.scale.height;
      this.cameras.main.setSize(W, H);
      this.applyHerd(); // the field's spots follow the orientation
      this.followHero(true);
      this.declutter();  // against the camera's new view
    }
  }

  window.SheprdWorld = {
    layout,
    mount(el, opts) {
      const store = { opts: opts || {}, herd: null, sprite: { state: 'idle' }, props: [], mark: null };
      const f = fit(el);
      const scene = new World(store);
      const modes = Phaser.Scale.ScaleModes || Phaser.Scale;
      const game = new Phaser.Game({
        type: Phaser.AUTO, parent: el, width: f.w, height: f.h, backgroundColor: '#1e2c24',
        pixelArt: true, roundPixels: true, input: { keyboard: false }, audio: { noAudio: true },
        scale: { mode: modes.NONE, zoom: f.zoom, autoCenter: modes.NO_CENTER !== undefined ? modes.NO_CENTER : Phaser.Scale.NO_CENTER },
        scene: [scene],
      });
      let size = f, css = null;
      const world = {
        game, scene,
        setHerd(layout) { store.herd = layout; scene.applyHerd(); },
        setSprite(state) { store.sprite = { state: String(state || 'idle') }; scene.applySprite(); },
        setProps(list) { store.props = (list || []).filter(p => p && p.id && p.tile && p.rows); scene.applyProps(); },  // [{id, tile: [x, y], rows}]
        setMark(kind) { store.mark = kind || null; scene.applyMark(); },
        resize(insets) {  // insets: css px of the canvas the page's controls cover, {right, bottom}
          if (insets) css = insets;
          if (!game.isBooted) { game.events.once('ready', () => world.resize()); return; }  // the page relayouts before Phaser boots
          const n = layout(el, css);
          store.insets = n.insets;
          if (n.w === size.w && n.h === size.h && n.zoom === size.zoom) return;
          size = n;
          game.scale.resize(n.w, n.h); game.scale.setZoom(n.zoom);
          scene.onResize();
        },
        destroy() { game.destroy(true); },
      };
      return world;
    },
  };
})();
