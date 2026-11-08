// No browser, network, voice models or services: execute the shipped reloader, modules and call controller.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const here = __dirname;
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
function python(source, input = '') {
  const p = spawnSync('python3', ['-c', source], {cwd: here, input, encoding: 'utf8'});
  assert.equal(p.status, 0, p.stderr);
  return p.stdout;
}
const snapshot = JSON.parse(python('import json, live_ui; print(json.dumps(live_ui.snapshot()))'));

// A small DOM with real parentage/identity. Python's HTML parser supplies the actual call.html tree.
// Moving an audio ancestor or focused input records the browser side effects that a flat DOM stub misses.
let doc, audioMoves = 0;
class Node {
  [require('node:util').inspect.custom]() { return '<' + this.nodeName + (this.id ? '#' + this.id : '') + '>'; }
  constructor(name, attrs = {}, value = null) {
    this.nodeName = name; this.nodeType = name === '#text' ? 3 : name === '#comment' ? 8 : 1;
    this.attrs = {...attrs}; this.nodeValue = value; this.childNodes = []; this.parentNode = null;
    this.classList = {
      add: c => this.setAttribute('class', [...new Set([...this.classes, c])].join(' ')),
      remove: c => this.setAttribute('class', this.classes.filter(v => v !== c).join(' ')),
      contains: c => this.classes.includes(c),
    };
  }
  get classes() { return (this.attrs.class || '').split(/\s+/).filter(Boolean); }
  get id() { return this.attrs.id || ''; }
  get content() { return this.attrs.content; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
  get textContent() { return this.nodeType === 1 ? this.childNodes.map(n => n.textContent).join('') : this.nodeValue; }
  set textContent(value) { this.childNodes.forEach(n => { n.parentNode = null; }); this.childNodes = []; this.append(new Node('#text', {}, value)); }
  getAttributeNames() { return Object.keys(this.attrs); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  append(child) { this.insertBefore(child, null); }
  insertBefore(child, anchor) {
    if (child.parentNode) child.remove();
    const i = anchor ? this.childNodes.indexOf(anchor) : this.childNodes.length;
    assert.ok(i >= 0, 'insertBefore anchor belongs to its parent');
    this.childNodes.splice(i, 0, child); child.parentNode = this;
  }
  remove() {
    if (!this.parentNode) return;
    if (doc?.documentElement === this || doc?.documentElement.contains(this)) {
      if (this.id === 'voice' || this.querySelector('#voice')) audioMoves++;
      if (doc.activeElement && this.contains(doc.activeElement)) doc.activeElement = null;
    }
    const p = this.parentNode; p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null;
  }
  contains(other) { return this === other || this.childNodes.some(c => c.contains(other)); }
  cloneNode(deep = false) {
    const copy = new Node(this.nodeName, this.attrs, this.nodeValue);
    if (deep) this.childNodes.forEach(c => copy.append(c.cloneNode(true)));
    return copy;
  }
  querySelectorAll(selector) {
    const match = n => {
      if (n.nodeType !== 1) return false;
      if (selector[0] === '#') return n.id === selector.slice(1);
      const m = selector.match(/^(\w+)?\[([\w-]+)(?:="([^"]*)")?\]$/);
      assert.ok(m, 'test DOM supports selector ' + selector);
      return (!m[1] || n.nodeName === m[1].toUpperCase()) && n.getAttribute(m[2]) !== null && (m[3] === undefined || n.getAttribute(m[2]) === m[3]);
    };
    return this.childNodes.flatMap(c => [...(match(c) ? [c] : []), ...c.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function parse(html) {
  const tree = JSON.parse(python(`
import json, sys
from html.parser import HTMLParser
class Parser(HTMLParser):
    def __init__(self):
        super().__init__(); self.root = ['ROOT', {}, None, []]; self.stack = [self.root]
    def handle_starttag(self, tag, attrs):
        n = [tag.upper(), dict((k, v or '') for k, v in attrs), None, []]
        self.stack[-1][3].append(n)
        if tag not in 'area base br col embed hr img input link meta param source track wbr'.split(): self.stack.append(n)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if self.stack[-1][0] == tag.upper(): self.stack.pop()
    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i][0] == tag.upper(): self.stack = self.stack[:i]; break
    def handle_data(self, value): self.stack[-1][3].append(['#text', {}, value, []])
    def handle_comment(self, value): self.stack[-1][3].append(['#comment', {}, value, []])
p = Parser(); p.feed(sys.stdin.read()); print(json.dumps(next(n for n in p.root[3] if n[0] == 'HTML')))
`, html));
  function build([tag, attrs, value, children]) { const n = new Node(tag, attrs, value); children.forEach(c => n.append(build(c))); return n; }
  const root = build(tree);
  return {documentElement: root, querySelector: s => root.querySelector(s), querySelectorAll: s => root.querySelectorAll(s),
    getElementById: id => root.querySelector('#' + id), activeElement: null};
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
async function reloadTests() {
  doc = parse(snapshot.html);
  const timers = new Map(), fetches = [], warnings = [], stages = [], delays = [];
  let reply = snapshot, fail = false, resolveFetch, defer = false, timerId = 0;
  const context = vm.createContext({document: doc, URL, AbortController,
    location: {href: 'https://voice.example.ts.net/call', origin: 'https://voice.example.ts.net'},
    console: {warn: (...args) => warnings.push(args)}, Phaser: {Scene: class {}},
    DOMParser: class { parseFromString(html) { return parse(html); } },
    setTimeout(fn, ms) { timers.set(++timerId, fn); delays.push(ms); return timerId; }, clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      fetches.push({url, options});
      if (defer) { defer = false; await new Promise(resolve => { resolveFetch = resolve; }); }
      if (fail) throw new Error('offline');
      const body = reply; return {ok: true, json: async () => body};
    },
  });
  context.window = context;
  vm.runInContext(read('world/reload.js'), context);
  context.SheprdLive.start(stage => stages.push(stage));
  const id = name => doc.getElementById(name);
  const audio = id('voice'), stream = {}, peer = {connectionState: 'connected'}, track = {enabled: false};
  audio.srcObject = stream; audio.play = audio.pause = () => assert.fail('reload touched audio playback');
  context.pc = peer; context.mic = {getTracks: () => [track]};
  id('screen').classList.add('busy'); id('screen').classList.add('hearing');
  id('status').textContent = 'Call is live';
  const input = id('typed'); input.value = 'unfinished draft'; doc.activeElement = input;
  const inputHint = new Node('SPAN'); input.parentNode.append(inputHint);
  const dialogue = new Node('LI'); dialogue.textContent = 'existing conversation'; id('lines').append(dialogue);
  const canvas = new Node('CANVAS'); id('world').append(canvas);
  const upload = new Node('P'); id('uploads').append(upload);
  const listener = () => {}; id('mute').onclick = listener;
  let serial = 0;
  function update(html = reply.html, assets = reply.assets) { return {...reply, html, assets, revision: (++serial).toString(16).padStart(64, '0')}; }
  async function send(ui) { reply = ui; context.SheprdLive.notify({type: 'ui-update', revision: ui.revision}); await settle(); }
  function alive() {
    assert.equal(id('voice'), audio); assert.equal(audio.srcObject, stream); assert.equal(audioMoves, 0);
    assert.equal(context.pc, peer); assert.equal(peer.connectionState, 'connected'); assert.equal(track.enabled, false);
    assert.equal(id('typed'), input); assert.equal(input.value, 'unfinished draft'); assert.equal(doc.activeElement, input);
    assert.equal(id('lines').childNodes[0], dialogue); assert.equal(canvas.parentNode, id('world'));
    assert.equal(upload.parentNode, id('uploads')); assert.equal(id('mute').onclick, listener);
    assert.ok(id('screen').classList.contains('busy')); assert.ok(id('screen').classList.contains('hearing'));
    assert.equal(id('status').textContent, 'Call is live');
  }
  const markup = snapshot.html.replace('<title>Sheprd</title>', '<title>Sheprd updated</title><link rel="stylesheet" href="/sheprd/style.css">')
    .replace('--grass: #9bbb6c', '--grass: #abcdef')
    .replace('<button id="copy" class="action" type="button">Copy</button>', '')
    .replace('<label id="typedlabel" for="typed" class="sr">Type to Sheprd (Enter sends)</label>', '')
    .replace('<div id="controls">', '<aside id="newcontrol">New control</aside><div id="controls">');
  await send(update(markup));
  assert.equal(warnings.length, 0, String(warnings[0])); assert.equal(stages.length, 1);
  assert.equal(doc.documentElement.childNodes.find(n => n.nodeName === 'HEAD').childNodes.find(n => n.nodeName === 'TITLE').textContent, 'Sheprd updated');
  assert.ok(doc.documentElement.textContent.includes('--grass: #abcdef')); assert.equal(id('copy'), null);
  assert.equal(id('newcontrol').textContent, 'New control'); alive();
  assert.ok(doc.querySelector('link[rel="stylesheet"]').getAttribute('href').endsWith('?ui=' + reply.revision));
  assert.equal(fetches[0].options.headers['X-Sheprd'], '1'); assert.equal(fetches[0].options.cache, 'no-store');
  context.SheprdLive.notify({revision: reply.revision}); await settle(); assert.equal(fetches.length, 1, 'duplicate revision does not fetch');
  const dismiss = id('dismiss'), freshDismiss = dismiss.cloneNode(true), parent = dismiss.parentNode, anchor = dismiss.nextSibling;
  dismiss.remove(); parent.insertBefore(freshDismiss, anchor);
  await send(update(reply.html.replace('<button id="dismiss" class="action" type="button">Dismiss</button>', '')));
  assert.equal(id('dismiss'), null, 'authored removal also removes a node the controller replaced'); alive();
  await send(update(reply.html.replace('New control', 'Changed control')));
  assert.equal(stages.length, 1, 'markup-only change keeps the module instances'); assert.equal(id('newcontrol').textContent, 'Changed control'); alive();
  await send(update(reply.html, {...reply.assets, 'tiles.js': reply.assets['tiles.js'] + '\nwindow.SHEPRD.hotTile = 7;',
    'games/run.js': reply.assets['games/run.js'].replace("name: 'Run'", "name: 'Live Run'")}));
  assert.equal(stages.length, 2); assert.equal(stages[1].SHEPRD.hotTile, 7);
  assert.equal(stages[1].SheprdGames.get('run').name, 'Live Run'); alive();
  const good = reply;
  const missingGame = {...reply.assets}; delete missingGame['games/run.js'];
  await send(update(reply.html, missingGame));
  assert.equal(stages.length, 2, 'incomplete module copy keeps the previous registry'); alive();
  await send(update(reply.html.replace('Changed control', 'Must not appear'), {...reply.assets, 'tiles.js': 'invalid javascript {'}));
  assert.equal(stages.length, 2); assert.equal(id('newcontrol').textContent, 'Changed control'); alive();
  assert.ok(timers.size, 'broken module schedules a retry');
  reply = update(good.html, good.assets);
  const retry = [...timers.values()].at(-1); timers.clear(); retry(); await settle();
  assert.equal(stages.length, 2); alive();
  await send(update(reply.html.replace('<audio id="voice" autoplay></audio>', '')));
  assert.equal(id('voice'), audio); alive();
  await send(update(good.html.replace('<input id="typed"', '<textarea id="typed"')));
  assert.equal(id('typed'), input); alive();
  fail = true; await send(update(good.html)); alive(); assert.ok(timers.size);
  const fetched = fetches.length;
  context.SheprdLive.notify({revision: reply.revision}); await settle();
  assert.equal(fetches.length, fetched, 'a poll repeating the failing revision waits for the back-off timer');
  for (let i = 0; i < 4; i++) { const next = [...timers.values()].at(-1); timers.clear(); next(); await settle(); }
  assert.equal(fetches.length, fetched + 4);
  assert.deepEqual(delays.filter(ms => ms !== 6500).slice(-4), [3000, 6000, 12000, 24000], 'retries back off');
  assert.equal(timers.size, 0, 'retries stop after five tries'); assert.match(String(warnings.at(-1)[0]), /stopped after 5 tries/);
  context.SheprdLive.notify({revision: reply.revision}); await settle();
  assert.equal(fetches.length, fetched + 4, 'a stopped revision stays stopped'); alive();
  fail = false; defer = true;
  const first = update(good.html), latest = update(good.html.replace('Changed control', 'Latest control'));
  reply = first; context.SheprdLive.notify({revision: first.revision}); await settle();
  reply = latest; context.SheprdLive.notify({revision: latest.revision}); resolveFetch(); await settle();
  assert.equal(id('newcontrol').textContent, 'Latest control'); alive();
  console.log('PASS: pushed markup/CSS/world/game swaps preserve audio, peer, mute, draft, listeners and live DOM; failures back off 3/6/12/24 s then stop until a newer push; newest push wins');
}
async function controllerTests() {
  const h = require('./ui_harness.cjs'); h.reset();
  let applied;
  const c = h.load('?plain', {SheprdLive: {start(fn) { applied = fn; }, notify() {} }});
  c.window = c;
  const peer = {connectionState: 'connected'}, track = {enabled: false}; c.probe.pc = peer; c.probe.mic = {getTracks: () => [track]};
  c.appMessage({data: JSON.stringify({type: 'say', text: 'Still speaking.', speaker: null})});
  const line = h.newest().li, voice = h.document.getElementById('voice'), stream = {};
  voice.srcObject = stream;
  c.thinking(true); c.game.show(); c.game.jump();
  let destroyed = 0, replaced = 0;
  const replacement = {setHerd() {}, setProps() {}, setMark() {}, setSprite() {}, resize() {}};
  const stage = {SHEPRD: {SPRITES: {camera: {rows: () => []}}, signGrid: () => ({rows: () => []})}, SheprdGames: c.SheprdGames,
    SheprdWorld: {mount() { replaced++; return replacement; }}};
  applied(stage);
  assert.equal(replaced, 1); assert.equal(voice.srcObject, stream); assert.equal(c.probe.pc, peer); assert.equal(track.enabled, false);
  assert.equal(h.newest().li, line); assert.equal(c.game.on(), true); assert.equal(c.game.current.id, 'run');
  replacement.destroy = () => { destroyed++; };
  applied(stage); assert.equal(destroyed, 1, 'previous renderer is disposed once');
  const notices = []; c.SheprdLive.notify = m => notices.push(m);
  c.appMessage({data: JSON.stringify({type: 'ui-update', revision: 'a'.repeat(64)})});
  assert.equal(notices[0].revision, 'a'.repeat(64));
  console.log('PASS: call controller replaces renderers/games and handles ui-update on the existing data channel without reconnecting');
}
(async () => {
  await reloadTests(); await controllerTests();
  const result = spawnSync('python3', ['-m', 'unittest', '-q', 'test_live_reload', 'test_call_screen'], {cwd: here, encoding: 'utf8'});
  process.stdout.write(result.stdout); process.stdout.write(result.stderr);
  assert.equal(result.status, 0, 'backend watcher/protocol checks failed');
})().catch(error => { console.error(error); process.exitCode = 1; });
