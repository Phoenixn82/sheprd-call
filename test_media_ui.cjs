// Node-only UI behavior check; no browser, network, files outside a temporary test tree, or live call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(__dirname + '/call.html', 'utf8');
class Element {
  constructor() { this.children = []; this.events = {}; this.hidden = false; this.style = {};
    this.classList = {add(){}, remove(){}, toggle(){}, contains(){ return false; }}; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute(name, value) { (this.attrs ||= {})[name] = value; }
  getAttribute(name) { return this.attrs?.[name] ?? null; }
  removeAttribute(name) { if (this.attrs) delete this.attrs[name]; }
  cloneNode() { const copy = new Element(); copy.attrs = {...this.attrs}; return copy; }
  replaceWith(other) { this.replacedBy = other; for (const [id, el] of elements) if (el === this) elements.set(id, other); }
  focus() {}
  getBoundingClientRect() { return {width: 300}; }
  getContext() { return new Proxy({}, {get: () => () => {}}); }
  click() { this.clicked = true; this.events.click?.({stopPropagation(){}}); }
  replaceChildren(...children) { this.children.splice(0, this.children.length, ...children); }
}
const elements = new Map();
const document = {hidden: false, events: {}, addEventListener(name, fn) { this.events[name] = fn; }, getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
  createElement() { return new Element(); }};
const requests = [], polls = [], timers = [];
let clock = 0;
class XHR {
  constructor() { this.upload = {}; requests.push(this); }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { (this.headers ||= {})[name] = value; }
  send(file) { this.body = file; }
}
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1] +
  ';globalThis.probe = {set pc(v) { pc = v; }, set events(v) { events = v; }, checkPlayout};';
const SheprdGames = require('./ui_harness.cjs').SheprdGames;  // the real game registry, so the picker lists every module
const page = (search, assigned = []) => ({document, XMLHttpRequest: XHR, URLSearchParams, AbortController, SheprdGames,
  location: {search, assign(url) { assigned.push(url); }}, performance: {now: () => clock}, devicePixelRatio: 1,
  localStorage:{getItem(){return null;}, setItem(){}}, addEventListener(){}, setTimeout(fn){timers.push(fn);}, clearTimeout(){},
  requestAnimationFrame(){}, cancelAnimationFrame(){},
  fetch:async(url) => {if (url === 'api/show' || url === 'api/herd') return {ok:true, json: async()=>null};
    polls.push(url); return {ok:true, json: async()=>({state:'sent'})};}});
const context = page('');
vm.runInNewContext(script, context);
(async () => {
  document.getElementById('attach').click();
  assert.equal(document.getElementById('media').clicked, true);
  const picker = document.getElementById('media');
  picker.files = [{name:'clip.mp4', type:'video/mp4'}, {name:'photo.jpg', type:'image/jpeg'}];
  picker.events.change();
  assert.equal(requests.length, 2); assert.equal(picker.value, '');
  const rows = document.getElementById('uploads').children;
  assert.equal(requests[0].headers['X-Sheprd'], '1');  // the voice host's Guard refuses an upload without it
  requests[0].upload.onprogress({lengthComputable:true,loaded:5,total:10});
  assert.equal(rows[0].children[2].textContent, 'Uploading: 50%');
  requests[0].status = 202; requests[0].responseText = '{"id":"123-abcdef012345"}'; requests[0].onload();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows[0].children[2].textContent, 'Sent. Claude is looking at it.');
  assert.equal(polls.length, 1);
  requests[1].status = 413; requests[1].responseText = '{"detail":"Photo or video exceeds 4 GB"}'; requests[1].onload();
  assert.equal(rows[1].children[2].textContent, 'Photo or video exceeds 4 GB');
  assert.equal(rows[1].children[3].hidden, false);
  rows[1].children[3].click(); assert.equal(requests.length, 3);
  assert.equal(requests[2].body.name, 'photo.jpg');
  console.log('PASS: picker, multiple uploads, percent, delivery status, plain error and retry (6 checks)');

  // Games stay closed while Claude thinks. The PLAY sign opens the picker; Close game works during a run.
  const pad = document.getElementById('pad'), hint = document.getElementById('gamehint'), gamePicker = document.getElementById('picker');
  for (const id of ['card', 'handoff', 'herd', 'herdlist']) document.getElementById(id).hidden = true;
  context.thinking(true);
  assert.equal(context.game.on(), false);
  document.getElementById('gamesopen').click();
  assert.equal(context.game.on(), true);
  assert.equal(gamePicker.children.length, 11, 'one picker key per registered game');
  assert.match(hint.textContent, /^Tap to play Run while you wait/);
  gamePicker.children.find((b) => b.getAttribute('data-key') === 'flap').click();
  assert.equal(context.game.current.id, 'flap'); assert.match(pad.getAttribute('aria-label'), /^Flap: tap here or press space to flap/);
  pad.click(); assert.equal(hint.textContent, 'Tap to flap through the gaps.');
  gamePicker.children.find((b) => b.getAttribute('data-key') === 'run').click();
  assert.equal(context.game.current.id, 'flap', 'no switching mid-run');
  context.thinking(false);
  assert.equal(context.game.on(), true, 'an answer does not close the chosen game');
  document.getElementById('gameclose').click();
  assert.equal(context.game.on(), false);
  context.thinking(true);
  assert.equal(context.game.on(), false, 'closed games stay closed on the next busy event');
  document.getElementById('gamesopen').click(); context.hangup();
  assert.equal(context.game.on(), false);
  console.log('PASS: the pad starts the picked game; the picker lists every module; off outside the game');

  // A sign-in link opens on Sheprd's face; Back keeps it waiting; null or hang up closes it (2026-11-05).
  // No sign-in button (2026-11-07): the frame opens on its own; parked, the Shepherd (and his mirror button) reopens it.
  const box = document.getElementById('handoff'), reopen = document.getElementById('btn');
  assert.ok(!require('fs').readFileSync(__dirname + '/call.html', 'utf8').includes('id="handoffopen"'), 'no sign-in button in the markup');
  const url = 'https://box.example.ts.net/web-handoff/h/' + 'A'.repeat(32);
  for (const bad of ['http://evil.example/web-handoff/h/' + 'A'.repeat(32), 'http://box.example.ts.net/h/abc',
                     'javascript:alert(1)', 'https://box.example.ts.net/h/../x']) {
    context.appMessage({data: JSON.stringify({type: 'handoff', url: bad})});
    assert.equal(document.getElementById('handoffframe').getAttribute('src'), null, bad);
  }
  // the bridge's default pattern: any https path on a *.ts.net host
  context.appMessage({data: JSON.stringify({type: 'handoff', url: 'https://box.example.ts.net/h/abc'})});
  assert.equal(document.getElementById('handoffframe').getAttribute('src'), 'https://box.example.ts.net/h/abc');
  context.appMessage({data: JSON.stringify({type: 'handoff', url, reason: 'sign in to Google'})});
  const frame = document.getElementById('handoffframe');
  assert.equal(frame.getAttribute('src'), url); assert.equal(box.hidden, false);
  assert.equal(document.getElementById('handofftext').textContent, 'Your desk needs you: sign in to Google');
  document.getElementById('handoffback').click();
  assert.equal(box.hidden, true); assert.equal(reopen.textContent, 'Sign-in waiting: open it');
  reopen.click(); assert.equal(box.hidden, false); assert.notEqual(reopen.textContent, 'Sign-in waiting: open it');
  context.appMessage({data: JSON.stringify({type: 'handoff'})});
  assert.equal(box.hidden, true); assert.notEqual(reopen.textContent, 'Sign-in waiting: open it');  // the mirror button (#btn) stays; only its label drops the sign-in
  assert.equal(frame.replacedBy.getAttribute('src'), null); assert.equal(document.getElementById('handoffframe'), frame.replacedBy);
  console.log('PASS: handoff link frames on the face, Back keeps it, end closes it, foreign links refused');

  // Only a speaker that stops pulling audio twice in a row is rebuilt; a return to the app only reports.
  const sent = [], voice = document.getElementById('voice'), stream = {id: 'desk'};
  let played = 10, reassigned = [];
  Object.defineProperty(voice, 'srcObject', {get() { return this._s; }, set(v) { reassigned.push(v); this._s = v; }, configurable: true});
  voice._s = stream; voice.paused = false; voice.play = async () => {};
  const peer = {connectionState: 'connected', getStats: async () => new Map([['AP', {type: 'media-playout', totalSamplesDuration: played}]])};
  context.probe.pc = peer; context.probe.events = {readyState: 'open', send: (m) => sent.push(JSON.parse(m))};
  clock = 100000;
  const tick = async () => { await context.probe.checkPlayout(peer); await new Promise(resolve => setImmediate(resolve)); };
  await tick(); played += 2; await tick();
  await tick();  // one stalled check: wait
  assert.equal(sent.length, 0); assert.equal(reassigned.length, 0);
  await tick();  // second stalled check: rebuild
  assert.deepEqual(reassigned, [null, stream]); assert.equal(sent[0].reason, 'playout stalled: before');
  assert.equal(sent[0].played, 12);
  document.hidden = true; document.events.visibilitychange(); document.hidden = false;
  document.events.visibilitychange();
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.at(-2).reason, 'hidden'); assert.equal(sent.at(-1).reason, 'back in the app');
  assert.equal(reassigned.length, 2);  // a return never rebuilds a working output
  context.probe.pc = null;
  console.log('PASS: two stalled checks rebuild the voice; returning to the app only reports');

  // Sheprd's screen (no mic): the Shepherd (and his mirror button) opens the real call, and an empty desk says so.
  elements.clear();
  const assigned = [];
  vm.runInNewContext(script, page('?view&plain', assigned));
  document.getElementById('card').hidden = true;
  await new Promise(resolve => setImmediate(resolve));
  assert.match(document.getElementById('status').textContent, /^No cards from the desk yet/);
  document.getElementById('btn').click();
  assert.deepEqual(assigned, ['call?auto']);
  console.log('PASS: Sheprd screen: the Shepherd opens the call; empty state');
})().catch(error => {console.error(error); process.exitCode=1;});
