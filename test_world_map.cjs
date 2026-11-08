// Node-only check of the map and the pathfinder (no Phaser): px.js and tiles.js load as plain scripts; the Shepherd's
// yard reaches the pasture through the gate, the fence still blocks, and an unreachable target gives no path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = {};
for (const f of ['px.js', 'tiles.js']) vm.runInNewContext(fs.readFileSync(__dirname + '/world/' + f, 'utf8'), context);
const SH = context.SHEPRD;
const {walk} = SH.buildMap();
const walkable = (x, y) => !!(walk[y] && walk[y][x]);

assert.equal(walkable(13, 15), true); assert.equal(walkable(14, 15), true);  // both halves of the gate
assert.equal(walkable(12, 15), false); assert.equal(walkable(15, 15), false);  // the fence either side
assert.equal(walkable(0, 0), false);

const path = SH.findPath(walk, {x: 13, y: 16}, {x: 13, y: 14});
assert.ok(path && path.length >= 2, 'no path from the yard to the pasture');
assert.equal(path.at(-1).x + ',' + path.at(-1).y, '13,14');
let prev = {x: 13, y: 16};
for (const p of path) {
  assert.equal(Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y), 1, 'steps are 4-adjacent');
  assert.equal(walkable(p.x, p.y), true, 'every step is walkable');
  prev = p;
}
assert.equal(SH.findPath(walk, {x: 13, y: 16}, {x: 0, y: 0}), null);
assert.equal(SH.findPath(walk, {x: 13, y: 16}, {x: 13, y: 16}).length, 0);
console.log('PASS: gate walkable, fence blocks, yard reaches pasture, unreachable is null (' + path.length + ' steps)');

// world.js loads without Phaser's engine (a Scene stub) so its pure layout helper can be checked: the page hands
// insets in css px and the world converts them with the zoom of the size it is being laid out for, not the last one.
context.window = context; context.Phaser = {Scene: class {}}; context.devicePixelRatio = 2.625;
vm.runInNewContext(fs.readFileSync(__dirname + '/world/world.js', 'utf8'), context);
const css = {right: 92, bottom: 70};
const tall = context.SheprdWorld.layout({clientWidth: 915, clientHeight: 550}, css);
const short = context.SheprdWorld.layout({clientWidth: 915, clientHeight: 320}, css);
assert.notEqual(tall.zoom, short.zoom, 'the two heights pick different scales');
for (const l of [tall, short]) {
  assert.ok(l.insets.right * l.zoom >= 92 && l.insets.right * l.zoom < 92 + l.zoom, 'right inset covers the key strip: ' + JSON.stringify(l));
  assert.ok(l.insets.bottom * l.zoom >= 70 && l.insets.bottom * l.zoom < 70 + l.zoom, 'bottom inset covers the text box: ' + JSON.stringify(l));
}
const none = context.SheprdWorld.layout({clientWidth: 412, clientHeight: 915}, {right: 0, bottom: 0}).insets;
assert.equal(none.right + ',' + none.bottom, '0,0');
console.log('PASS: landscape insets follow the zoom of the new size (' + tall.insets.right + ' at zoom ' + tall.zoom.toFixed(2) + ', ' + short.insets.right + ' at ' + short.zoom.toFixed(2) + ')');
