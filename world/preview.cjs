#!/usr/bin/env node
// Dev-only: render world art to PNG without a browser, for checking pixels at a zoom.
// node preview.cjs <map|sprites|portraits|tiles> <zoom> <out.png>
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), vm = require('vm');
for (const f of ['px.js', 'font.js', 'tiles.js', 'sprites.js', 'portraits.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), { filename: f });
}
const SH = globalThis.SHEPRD;

function png(grid, zoom, palette, bgHex) {
  const w = grid.w * zoom, h = grid.h * zoom;
  const rgb = palette.map(hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
  const bg = bgHex ? [parseInt(bgHex.slice(1, 3), 16), parseInt(bgHex.slice(3, 5), 16), parseInt(bgHex.slice(5, 7), 16)] : [255, 0, 255];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const c = grid.get(Math.floor(x / zoom), Math.floor(y / zoom));
      const col = c === '.' ? bg : rgb[c.charCodeAt(0) - 48];
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = col[0]; raw[o + 1] = col[1]; raw[o + 2] = col[2];
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function sheet(grids, cols, pad, fill) {
  const w = Math.max(...grids.map(g => g.w)), h = Math.max(...grids.map(g => g.h));
  const rows = Math.ceil(grids.length / cols);
  const out = new SH.Grid(cols * (w + pad) + pad, rows * (h + pad) + pad, fill);
  grids.forEach((g, i) => out.stampGrid(g, pad + (i % cols) * (w + pad), pad + Math.floor(i / cols) * (h + pad)));
  return out;
}

const [what, zoomS, out] = process.argv.slice(2);
const zoom = parseInt(zoomS || '4', 10);
let grid, palette = SH.PALETTE, bg = '#9bbb6c';
if (what === 'map') grid = SH.buildMap().grid;
else if (what === 'tiles') grid = sheet(Object.values(SH.TILES), 4, 2, '.');
else if (what === 'sprites') {
  const s = SH.SPRITES;
  grid = sheet([s.shepherd.down0, s.shepherd.down1, s.shepherd.up0, s.shepherd.up1, s.shepherd.left0, s.shepherd.left1, s.shepherd.right0, s.shepherd.right1,
    s.sheep.left0, s.sheep.left1, s.sheep.right0, s.sheep.right1, s.balloon, SH.tagGrid('api-tests'), SH.tagGrid('refactor'),
    ...SH.HAT_NAMES.flatMap(h => { const f = SH.sheepFrames(h); return [f.left0, f.left1, f.right0]; })], 8, 2, '1');
  bg = '#ff00ff';
} else if (what === 'portraits') {
  palette = SH.PORTRAIT_PALETTE; bg = '#ffffff';
  const names = SH.PORTRAITS.list();
  grid = sheet(names.map(n => SH.PORTRAITS.render(n)), 4, 2, '.');
  console.log(names.join(' '));
} else if (what === 'text') {
  grid = SH.textGrid('The quick brown fox jumps', 'dialog', '3', '0'); palette = SH.PALETTE;
} else { console.error('what?'); process.exit(1); }
fs.writeFileSync(out, png(grid, zoom, palette, bg));
console.log(out, grid.w + 'x' + grid.h, 'zoom', zoom);
