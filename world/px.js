// Sheprd world: tiny indexed-colour raster helpers shared by the art files.
// Every piece of art is a Grid of palette indices ('0'..'5') or '.' (transparent).
// Works in the browser (window.SHEPRD) and in node (globalThis.SHEPRD) for previews.
(function (root) {
  'use strict';
  const SH = root.SHEPRD = root.SHEPRD || {};

  // 4-shade overworld palette (own choice: warm green-gray, reads on a phone).
  // Index 0 is the lightest. Portraits may also use the two in-between shades.
  SH.PALETTE = ['#e4ecc8', '#9bbb6c', '#4f7a5a', '#1e2c24'];
  SH.PORTRAIT_PALETTE = ['#e4ecc8', '#c6d7a0', '#9bbb6c', '#4f7a5a', '#35503a', '#1e2c24'];

  class Grid {
    constructor(w, h, fill) {
      this.w = w; this.h = h;
      this.d = new Array(w * h).fill(fill === undefined ? '.' : fill);
    }
    static fromRows(rows) {
      const h = rows.length, w = rows[0].length;
      const g = new Grid(w, h);
      for (let y = 0; y < h; y++) {
        if (rows[y].length !== w) throw new Error('row ' + y + ' is ' + rows[y].length + ' wide, expected ' + w + ': ' + rows[y]);
        for (let x = 0; x < w; x++) g.d[y * w + x] = rows[y][x];
      }
      return g;
    }
    get(x, y) { return (x < 0 || y < 0 || x >= this.w || y >= this.h) ? '.' : this.d[y * this.w + x]; }
    set(x, y, v) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = v; return this; }
    fill(v) { this.d.fill(v); return this; }
    rect(x, y, w, h, v) {
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, v);
      return this;
    }
    hline(x, y, w, v) { return this.rect(x, y, w, 1, v); }
    vline(x, y, h, v) { return this.rect(x, y, 1, h, v); }
    line(x0, y0, x1, y1, v) { // Bresenham
      let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
      for (;;) {
        this.set(x0, y0, v);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
      return this;
    }
    ellipse(cx, cy, rx, ry, v) { // filled, pixel-centre test
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
          if (nx * nx + ny * ny <= 1) this.set(x, y, v);
        }
      return this;
    }
    // Draw rows (array of strings) at x,y. '.' is skipped. map: optional {char: char} recolour.
    stamp(rows, x, y, map) {
      for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) {
        let c = rows[j][i];
        if (c === '.') continue;
        if (map && map[c] !== undefined) c = map[c];
        if (c === '.') continue;
        this.set(x + i, y + j, c);
      }
      return this;
    }
    stampGrid(g, x, y, map) { return this.stamp(g.rows(), x, y, map); }
    // Mirror horizontally (for the right eye, right-facing sprites).
    flipX() {
      const g = new Grid(this.w, this.h);
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) g.d[y * this.w + (this.w - 1 - x)] = this.d[y * this.w + x];
      return g;
    }
    // Every transparent pixel that touches an opaque one (4-neighbour) becomes v.
    outline(v) {
      const src = this.d.slice();
      const at = (x, y) => (x < 0 || y < 0 || x >= this.w || y >= this.h) ? '.' : src[y * this.w + x];
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
        if (at(x, y) !== '.') continue;
        if (at(x - 1, y) !== '.' || at(x + 1, y) !== '.' || at(x, y - 1) !== '.' || at(x, y + 1) !== '.') this.d[y * this.w + x] = v;
      }
      return this;
    }
    // Opaque pixels of value `from` that touch a transparent pixel become `to` (an inner edge).
    edge(from, to) {
      const src = this.d.slice();
      const at = (x, y) => (x < 0 || y < 0 || x >= this.w || y >= this.h) ? '.' : src[y * this.w + x];
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
        if (at(x, y) !== from) continue;
        if (at(x - 1, y) === '.' || at(x + 1, y) === '.' || at(x, y - 1) === '.' || at(x, y + 1) === '.') this.d[y * this.w + x] = to;
      }
      return this;
    }
    rows() {
      const out = [];
      for (let y = 0; y < this.h; y++) out.push(this.d.slice(y * this.w, (y + 1) * this.w).join(''));
      return out;
    }
    clone() { const g = new Grid(this.w, this.h); g.d = this.d.slice(); return g; }
  }
  SH.Grid = Grid;

  // Browser only: Grid -> HTMLCanvasElement using a palette (index chars map to colours).
  SH.gridToCanvas = function (grid, palette, canvas) {
    palette = palette || SH.PALETTE;
    const c = canvas || document.createElement('canvas');
    c.width = grid.w; c.height = grid.h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(grid.w, grid.h);
    const rgb = palette.map(hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
    for (let i = 0; i < grid.d.length; i++) {
      const ch = grid.d[i];
      if (ch === '.') continue;
      const col = rgb[ch.charCodeAt(0) - 48];
      img.data[i * 4] = col[0]; img.data[i * 4 + 1] = col[1]; img.data[i * 4 + 2] = col[2]; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  };

  // Lay several grids side by side into one strip (sprite sheet). Returns {grid, frames:{name:{x,y,w,h}}}.
  SH.strip = function (named) {
    const names = Object.keys(named);
    const w = names.reduce((s, n) => s + named[n].w, 0);
    const h = Math.max(...names.map(n => named[n].h));
    const g = new Grid(w, h);
    const frames = {};
    let x = 0;
    for (const n of names) {
      g.stampGrid(named[n], x, 0);
      frames[n] = { x, y: 0, w: named[n].w, h: named[n].h };
      x += named[n].w;
    }
    return { grid: g, frames };
  };
})(typeof window !== 'undefined' ? window : globalThis);
