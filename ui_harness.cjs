// Shared harness for the node-only page tests (test_bubble_ui, test_herd_ui, test_context_ui): the page's inline
// script runs in a vm with a fake document, a fake clock (performance.now), a timer queue the test advances by hand,
// a recording fetch with fake NDJSON streams, and a fake SheprdWorld that records every call the page makes to the
// world API (the page must work with no Phaser at all). No browser, no network.
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(__dirname + '/call.html', 'utf8');

const elements = new Map();
const HIDDEN = new Set([...html.matchAll(/<[^>]*\sid="([^"]+)"[^>]*\shidden[\s>]/g)].map((m) => m[1]));  // markup `hidden` starts hidden
const TAGS = new Map([...html.matchAll(/<(\w+)[^>]*\sid="([^"]+)"/g)].map((m) => [m[2], m[1]]));  // the markup's tag names
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.events = {}; this.hidden = false; this.style = {}; this.classes = new Set();
    this.textContent = ''; this.disabled = false; this.paused = true; this.volume = 1;
    const classes = this.classes;
    this.classList = {add(...c) { c.forEach((x) => classes.add(x)); }, remove(...c) { c.forEach((x) => classes.delete(x)); },
      toggle(c, on) { if (on === undefined) on = !classes.has(c); on ? classes.add(c) : classes.delete(c); return on; },
      contains(c) { return classes.has(c); }}; }
  append(...children) { for (const c of children) c.parentNode = this; this.children.push(...children); }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute(name, value) { (this.attrs ||= {})[name] = String(value); }
  getAttribute(name) { return this.attrs?.[name] ?? null; }
  removeAttribute(name) { if (this.attrs) delete this.attrs[name]; }
  cloneNode() { const copy = new Element(this.tag); copy.attrs = {...this.attrs}; return copy; }
  replaceWith(other) { for (const [id, el] of elements) if (el === this) elements.set(id, other); }
  replaceChildren(...children) {  // live like the DOM's; removing the focused node blurs it, even when it is put back
    const a = document.activeElement, inside = (list) => list.some((c) => c === a || (c.children && c.children.includes(a)));
    const gone = a && inside(this.children);
    for (const c of children) c.parentNode = this; this.children.splice(0, this.children.length, ...children);
    if (gone) document.activeElement = null;
  }
  focus() { document.activeElement = this; }
  remove() { const p = this.parentNode, i = p ? p.children.indexOf(this) : -1; if (i >= 0) p.children.splice(i, 1); this.parentNode = null; }  // like the DOM: detached after
  play() { this.paused = false; this.events.play?.(); return Promise.resolve(); }  // an <audio>
  pause() { this.paused = true; this.events.pause?.(); }
  getBoundingClientRect() { return {width: 300, height: 300}; }
  closest() { return null; }
  getContext() { return new Proxy({}, {get: () => () => {}}); }
  click() { this.clicked = true; this.events.click?.({stopPropagation() {}, preventDefault() {}}); }
}
const document = {hidden: false, events: {}, activeElement: null, addEventListener(name, fn) { this.events[name] = fn; },
  getElementById(id) { if (!elements.has(id)) { const e = new Element(TAGS.get(id) || 'div'); e.hidden = HIDDEN.has(id); elements.set(id, e); } return elements.get(id); },
  createElement(tag) { return new Element(tag); }};

let clock = 0, timerId = 0;
const timers = new Map();
const setTimeout_ = (fn, ms = 0) => { timers.set(++timerId, {fn, at: clock + ms}); return timerId; };
const clearTimeout_ = (id) => { timers.delete(id); };
async function advance(ms) {  // move the fake clock forward, firing timers in order as they come due
  const target = clock + ms;
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    clock = Math.max(clock, due[1].at); timers.delete(due[0]); due[1].fn();
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  }
  clock = target;
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };

const fetches = [], streams = [];
class Stream {  // a fake NDJSON response body the test feeds line by line
  constructor(signal) { this.queue = []; this.waiting = null; this.cancelled = false; streams.push(this);
    signal?.addEventListener('abort', () => { this.cancelled = true; this.waiting?.resolve({done: true}); }); }
  push(line) { const chunk = new TextEncoder().encode(line + '\n');
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve({done: false, value: chunk}); } else this.queue.push(chunk); }
  getReader() { const self = this; return {
    read() { if (self.cancelled) return Promise.resolve({done: true});
      if (self.queue.length) return Promise.resolve({done: false, value: self.queue.shift()});
      return new Promise((resolve) => { self.waiting = {resolve}; }); },
    cancel() { self.cancelled = true; self.waiting?.resolve({done: true}); return Promise.resolve(); } }; }
}
// Default replies; a test may override `replies` (url -> response or (url, opts) -> response) before acting.
const replies = {};
async function fetch_(url, opts = {}) {
  fetches.push({url, body: opts.body, method: opts.method, headers: opts.headers});
  for (const key in replies) if (url === key || (key.endsWith('*') && url.startsWith(key.slice(0, -1)))) {
    const r = replies[key]; return typeof r === 'function' ? r(url, opts) : r;
  }
  if (url === 'api/show' || url === 'api/herd') return {ok: true, json: async () => null};
  if (url.startsWith('api/events')) return {ok: true, status: 200, body: new Stream(opts.signal)};
  return {ok: true, status: 202, json: async () => ({})};
}

// The real game registry and modules (world/games.js, world/games/*.js) in their own realm: the page's picker lists them.
const SheprdGames = (() => {
  const c = { document: undefined };
  vm.runInNewContext(fs.readFileSync(__dirname + '/world/games.js', 'utf8'), c);
  for (const id of c.SheprdGames.REGISTRY) vm.runInNewContext(fs.readFileSync(__dirname + '/world/games/' + id + '.js', 'utf8'), c);
  return c.SheprdGames;
})();

// The fake world: records every call; `mount` keeps the page's callbacks so a test can tap a sheep or the barn.
const world = {calls: [], opts: null, el: null};
const SheprdWorld = {
  mount(el, opts) { world.el = el; world.opts = opts; world.calls.push(['mount']);
    return {setHerd(layout) { world.calls.push(['setHerd', JSON.parse(JSON.stringify(layout))]); },
            setSprite(...args) { world.calls.push(['setSprite', ...JSON.parse(JSON.stringify(args))]); },
            resize(insets) { world.calls.push(['resize', insets && JSON.parse(JSON.stringify(insets))]); }}; },
};
const last = (name) => world.calls.filter((c) => c[0] === name).at(-1);
// The thread's newest box: {kind, who, words, face} (face: the expression name on the portrait, or null for his own box).
const newest = () => { const li = document.getElementById('lines').children.at(-1); if (!li) return null;
  const by = (cls) => li.children.find((c) => c.classes.has(cls));
  return {kind: ['desk', 'sheep', 'you'].find((k) => li.classes.has(k)), who: by('who').textContent, words: by('words').textContent,
    face: by('face') ? by('face').getAttribute('data-face') : null, live: li.classes.has('live'), li}; };  // the picture itself needs a canvas
const boxes = () => document.getElementById('lines').children.length;

const plain = (v) => JSON.parse(JSON.stringify(v));  // vm objects live in another realm
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1] +
  ';globalThis.probe = {set pc(v) { pc = v; }, get pc() { return pc; }, set events(v) { events = v; }, set mic(v) { mic = v; }, get talker() { return talker; }};';
const page = (search, extra = {}) => ({document, URLSearchParams, AbortController, TextDecoder, TextEncoder, innerWidth: 412, innerHeight: 915,
  location: {search, assign() {}}, performance: {now: () => clock}, devicePixelRatio: 1,
  localStorage: {getItem() { return null; }, setItem() {}}, addEventListener() {}, setTimeout: setTimeout_, clearTimeout: clearTimeout_,
  requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, SheprdWorld, SheprdGames, fetch: fetch_, ...extra});
function load(search = '', extra) { const context = page(search, extra); vm.runInNewContext(script, context); return context; }
function reset() { elements.clear(); fetches.length = 0; streams.length = 0; timers.clear(); world.calls.length = 0; for (const k in replies) delete replies[k]; }

module.exports = {html, Element, document, elements, advance, settle, fetches, streams, Stream, replies, world, last, newest, boxes, plain, script, page, load, reset, SheprdGames,
  get clock() { return clock; }, set clock(v) { clock = v; }};
