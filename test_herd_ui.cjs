// Node-only check of the herd on the page: herdLayout zones, the herd message reaching the world, the sheep panel
// (recap, Talk, Text, Back to Sheprd), the R19 +N list keyed by pane id, a real 7-agent `herdr agent list` through
// bridge.herd_of to six drawn sheep, and the page kept across leaving and reopening. No browser, no network.
const assert = require('node:assert/strict');
const H = require('./ui_harness.cjs');
const {document, fetches, replies, world, last, newest, plain} = H;

// the page's cleaned shape: name, a one-line recap (empty until the bridge has one), status, talk
const sheep = (id, status, extra = {}) => ({id, name: extra.name || id.replace(':', '-'), line: extra.line || '', status, talk: extra.talk !== false});
const ids = (list) => list.map((s) => s.id);

(async () => {
  const context = H.load('');
  const herdLayout = context.herdLayout;

  // Zones: working → field, blocked → gate, done → home, idle and unknown → rest beside the barn; every sheep is drawn.
  const herd = [sheep('w1:p1', 'working'), sheep('w1:p2', 'blocked'), sheep('w1:p3', 'done'), sheep('w1:p4', 'idle'),
                sheep('w1:p5', 'unknown'), sheep('w1:p6', 'working')];
  const layout = plain(herdLayout(herd));
  assert.deepEqual(ids(layout.field), ['w1:p1', 'w1:p6']);
  assert.deepEqual(ids(layout.gate), ['w1:p2']);
  assert.deepEqual(ids(layout.home), ['w1:p3']);
  assert.deepEqual(ids(layout.rest), ['w1:p4', 'w1:p5']); assert.equal(layout.more, 0);
  const twelve = Array.from({length: 12}, (_, i) => sheep('w2:p' + i, 'working'));
  const big = plain(herdLayout(twelve));
  assert.equal(big.field.length, 8); assert.equal(big.more, 4);
  assert.deepEqual(ids(big.field), ids(twelve).slice(0, 8));  // the first eight in herd order; the rest are the +N
  const none = plain(herdLayout([]));
  assert.deepEqual(none, {field: [], gate: [], home: [], rest: [], more: 0});
  // blocked sheep are placed before done and working ones when the herd overflows
  const mixed = plain(herdLayout(twelve.concat([sheep('w3:p1', 'blocked')])));
  assert.deepEqual(ids(mixed.gate), ['w3:p1']); assert.equal(mixed.field.length, 7); assert.equal(mixed.more, 5);
  // resting sheep are placed last: they fill what is left and overflow into the +N first
  const lazy = plain(herdLayout([...Array.from({length: 7}, (_, i) => sheep('w4:p' + i, 'idle')), sheep('w4:pW', 'working'), sheep('w4:pB', 'blocked')]));
  assert.deepEqual([ids(lazy.gate), ids(lazy.field), lazy.rest.length, lazy.more], [['w4:pB'], ['w4:pW'], 6, 1]);
  console.log('PASS: herdLayout zones, 12 -> 8 + 4, empty herd, blocked first, resting last');

  // A herd message hands herdLayout's output to the world; a sheep missing from the next herd is gone everywhere.
  assert.equal(world.calls[0][0], 'mount');
  context.appMessage({data: JSON.stringify({type: 'herd', herd})});
  assert.deepEqual(last('setHerd')[1], layout);
  context.appMessage({data: JSON.stringify({type: 'herd', herd: herd.filter((s) => s.id !== 'w1:p2' && s.id !== 'w1:p4')})});
  const next = last('setHerd')[1];
  assert.equal([...next.field, ...next.gate, ...next.home, ...next.rest].some((s) => s.id === 'w1:p2' || s.id === 'w1:p4'), false);
  assert.deepEqual(ids(next.rest), ['w1:p5']);
  // malformed entries never reach the world: a bad id is dropped, an unknown status reads as unknown
  context.appMessage({data: JSON.stringify({type: 'herd', herd: [sheep('../x', 'working'), {id: 'w1:p9', name: 'odd', status: 'weird'}]})});
  const odd = last('setHerd')[1];
  assert.deepEqual([odd.field, odd.gate, odd.home, ids(odd.rest)], [[], [], [], ['w1:p9']]);
  // the keyboard mirror lists the placed sheep as buttons keyed by id
  context.appMessage({data: JSON.stringify({type: 'herd', herd})});
  const mirror = document.getElementById('herdbuttons').children;
  assert.deepEqual(mirror.map((b) => b.getAttribute('data-id')), ['w1:p2', 'w1:p3', 'w1:p1', 'w1:p6', 'w1:p4', 'w1:p5']);
  assert.match(mirror[0].textContent, /w1-p2/); assert.match(mirror[0].textContent, /Needs you/);  // plain words, not "blocked"
  // the bridge's plain name and one-line recap win over the tab's own name, everywhere the sheep shows
  context.appMessage({data: JSON.stringify({type: 'herd', herd: herd.map((s) => s.id === 'w1:p2' ? {...s, plain: 'Gate latch', line: 'Stuck: needs the key from you.'} : s)})});
  assert.equal(last('setHerd')[1].gate[0].name, 'Gate latch');
  assert.match(mirror[0].textContent, /^Gate latch, Needs you$/);
  context.appMessage({data: JSON.stringify({type: 'herd', herd})});
  console.log('PASS: herd message reaches world.setHerd; removed sheep gone; bad entries dropped; keyboard mirror');

  // Tapping a sheep: a recap and nothing else. Its name and plain status at once, the one-liner (or "Getting a
  // recap...") until the fuller recap lands; never the tab's title, ids or raw transcript lines.
  fetches.length = 0;
  let release;
  replies['api/recap?id=w1%3Ap2&summary=1'] = {ok: true, json: () => new Promise((resolve) => { release = () => resolve({summary: 'Stuck on the key.',
    title: 'run brief claim 20261106-x', about: '/home/x/y.py', lately: ['raw line']}); })};
  const panel = document.getElementById('herd');
  assert.equal(panel.hidden, true);
  world.opts.onSheep('w1:p2');
  await H.settle();
  assert.equal(panel.hidden, false);
  assert.deepEqual(fetches.map((f) => f.url), ['api/recap?id=w1%3Ap2&summary=1']);
  assert.equal(document.getElementById('herdname').textContent, 'w1-p2');
  assert.equal(document.getElementById('herdstatus').textContent, 'Needs you');
  assert.equal(document.getElementById('herdsummary').textContent, 'Getting a recap...');
  release(); await H.settle();
  assert.equal(document.getElementById('herdsummary').textContent, 'Stuck on the key.');
  for (const gone of ['herdtitle', 'herdabout', 'herdlately']) assert.equal(H.html.includes('id="' + gone + '"'), false, gone);
  // Talk is a call feature (/api/target answers 409 off call): hidden off call, shown on a call, posts the id.
  const talk = document.getElementById('herdtalk');
  assert.equal(talk.hidden, true);
  context.probe.pc = {connectionState: 'connected'};
  world.opts.onSheep('w1:p2'); await H.settle();
  assert.equal(talk.hidden, false); assert.equal(talk.textContent, 'Talk');
  fetches.length = 0; talk.click(); await H.settle();
  assert.deepEqual([fetches[0].url, fetches[0].method, JSON.parse(fetches[0].body)], ['api/target', 'POST', {id: 'w1:p2'}]);
  assert.equal(fetches[0].headers['Content-Type'], 'application/json');  // the voice host refuses any other body type
  assert.equal(fetches[0].headers['X-Sheprd'], '1');  // and any request without it
  // while that sheep is the speaker, Back to Sheprd replaces Talk and posts null
  context.appMessage({data: JSON.stringify({type: 'speaker', id: 'w1:p2', name: 'w1-p2'})});
  assert.equal(talk.textContent, 'Back to Sheprd');
  fetches.length = 0; talk.click(); await H.settle();
  assert.deepEqual(JSON.parse(fetches[0].body), {id: null});
  context.appMessage({data: JSON.stringify({type: 'speaker', id: null, name: null})});
  assert.equal(talk.textContent, 'Talk');
  // Talk is absent when the sheep cannot be talked to
  context.appMessage({data: JSON.stringify({type: 'herd', herd: herd.map((s) => s.id === 'w1:p2' ? {...s, talk: false} : s)})});
  assert.equal(talk.hidden, true);
  context.appMessage({data: JSON.stringify({type: 'herd', herd})});
  // Text sends the box's words to that sheep; the panel's Close clears the target.
  const typed = document.getElementById('typed'), form = document.getElementById('typebox');
  document.getElementById('herdtext').click();
  assert.equal(document.activeElement, typed);
  assert.equal(typed.getAttribute('placeholder'), 'Type to w1-p2');
  H.streams.length = 0; fetches.length = 0; typed.value = 'how far along?'; form.events.submit({preventDefault() {}}); await H.settle();
  assert.equal(fetches.some((f) => f.url === 'api/turn'), false);  // on a call too, the sheep's stream opens first (R20)
  H.streams[0].push('{"ready": true}'); await H.settle();
  assert.deepEqual(JSON.parse(fetches.find((f) => f.url === 'api/turn').body), {text: 'how far along?', typed: true, to: 'w1:p2'});
  document.getElementById('herdclose').click();
  assert.equal(panel.hidden, true); assert.equal(typed.getAttribute('placeholder'), 'Type to Sheprd');
  context.probe.pc = null;
  // Recap unavailable on an error
  replies['api/recap?id=w1%3Ap3'] = {ok: false, status: 503, json: async () => ({})};
  world.opts.onSheep('w1:p3'); await H.settle();
  assert.equal(document.getElementById('herdsummary').textContent, 'Recap unavailable');
  // with a one-liner from the herd, a failed recap keeps showing it
  context.appMessage({data: JSON.stringify({type: 'herd', herd: herd.map((s) => s.id === 'w1:p3' ? {...s, line: 'Finished the docs.'} : s)})});
  world.opts.onSheep('w1:p3');
  assert.equal(document.getElementById('herdsummary').textContent, 'Finished the docs.');
  await H.settle();
  assert.equal(document.getElementById('herdsummary').textContent, 'Finished the docs.');
  context.appMessage({data: JSON.stringify({type: 'herd', herd})});
  document.getElementById('herdclose').click();
  console.log('PASS: sheep panel: recap then summary, Talk / Back to Sheprd, Text to the sheep, Close, Recap unavailable');

  // Off call, Text to a sheep follows that pane's stream first (R16/R20) and its answer shows in that sheep's thread box.
  H.streams.length = 0; fetches.length = 0;
  world.opts.onSheep('w1:p1'); await H.settle();
  document.getElementById('herdtext').click();
  typed.value = 'status?'; form.events.submit({preventDefault() {}}); await H.settle();
  const at = (u) => fetches.findIndex((f) => f.url === u);  // the sheep's stream opens before the turn
  assert.ok(at('api/events?follow=w1%3Ap1') >= 0 && at('api/turn') < 0, fetches.map((f) => f.url).join());  // the turn waits for ready
  H.streams[0].push('{"ready": true}'); await H.settle();
  assert.ok(at('api/turn') > at('api/events?follow=w1%3Ap1'));
  assert.deepEqual(JSON.parse(fetches.find((f) => f.url === 'api/turn').body), {text: 'status?', typed: true, to: 'w1:p1'});
  H.streams[0].push('{"say": "Nearly there."}'); await H.settle(); await H.advance(100);
  const d = newest();
  assert.equal(context.bubble.who, 'w1:p1'); assert.deepEqual([d.kind, d.who, d.words], ['sheep', 'w1-p1', 'Nearly']);
  document.getElementById('herdclose').click();
  console.log('PASS: Text to a sheep off call follows its stream, the reply lands in that sheep\'s thread box');

  // R19: the +N opens a list of the unplaced sheep keyed by id; each opens the same sheep panel.
  const list = document.getElementById('herdlist'), items = document.getElementById('herdlistitems');
  context.appMessage({data: JSON.stringify({type: 'herd', herd: twelve.map((s, i) => i === 9 ? {...s, status: 'unknown'} : s)})});
  world.opts.onMore();
  assert.equal(list.hidden, false);
  assert.deepEqual(items.children.map((li) => li.children[0].getAttribute('data-id')), ['w2:p8', 'w2:p10', 'w2:p11', 'w2:p9']);
  assert.equal(items.children[3].children[0].textContent, 'w2-p9: Quiet');  // name: one-liner, else the plain status
  assert.match(H.html, /<h2 id="herdlisttitle">More sheep<\/h2>/);
  items.children[0].children[0].click(); await H.settle();
  assert.equal(list.hidden, true); assert.equal(panel.hidden, false);
  assert.equal(document.getElementById('herdname').textContent, 'w2-p8');
  document.getElementById('herdclose').click();
  context.appMessage({data: JSON.stringify({type: 'herd', herd: twelve})});
  world.opts.onMore();
  assert.deepEqual(items.children.map((li) => li.children[0].getAttribute('data-id')), ['w2:p8', 'w2:p9', 'w2:p10', 'w2:p11']);
  document.getElementById('herdlistclose').click();
  assert.equal(list.hidden, true);
  // Escape closes the top panel
  world.opts.onMore(); document.events.keydown({key: 'Escape', preventDefault() {}});
  assert.equal(list.hidden, true);
  context.appMessage({data: JSON.stringify({type: 'herd', herd})});
  console.log('PASS: the +N list keyed by id opens the sheep panel; Escape closes');

  // Opening another sheep's panel drops the text recipient: the next line is a desk turn about the new sheep.
  context.appMessage({data: JSON.stringify({type: 'herd', herd})});
  world.opts.onSheep('w1:p1'); await H.settle();
  document.getElementById('herdtext').click();
  assert.equal(typed.getAttribute('placeholder'), 'Type to w1-p1');
  world.opts.onSheep('w1:p3'); await H.settle();
  assert.equal(typed.getAttribute('placeholder'), 'Type to Sheprd');
  H.streams.length = 0; fetches.length = 0; typed.value = 'and this one?'; form.events.submit({preventDefault() {}}); await H.settle();
  H.streams[0].push('{"ready": true}'); await H.settle();
  assert.deepEqual(JSON.parse(fetches.find((f) => f.url === 'api/turn').body), {text: 'and this one?', typed: true, context: {sheep: 'w1:p3'}});
  document.getElementById('herdclose').click();
  console.log('PASS: a new sheep panel resets the text recipient');

  // The keyboard mirror is keyed by pane id and updated in place: an unchanged herd touches nothing, so focus
  // survives a poll; a status change rewrites that button's text; the same holds for an open list.
  context.appMessage({data: JSON.stringify({type: 'herd', herd})});
  const before = [...mirror];
  before[1].focus();
  context.appMessage({data: JSON.stringify({type: 'herd', herd})});
  assert.deepEqual([...mirror], before);
  assert.equal(document.activeElement, before[1]);
  const changed = herd.map((s) => (s.id === 'w1:p3' ? {...s, status: 'blocked'} : s));
  context.appMessage({data: JSON.stringify({type: 'herd', herd: changed})});
  const b3 = mirror.find((b) => b.getAttribute('data-id') === 'w1:p3');
  assert.equal(b3, before[1]); assert.match(b3.textContent, /Needs you/);
  // a rebuild (order or membership changes) keeps focus on the same pane's button
  const two = [sheep('w9:p1', 'working'), sheep('w9:p2', 'working')];
  context.appMessage({data: JSON.stringify({type: 'herd', herd: two})});
  const first = mirror.find((b) => b.getAttribute('data-id') === 'w9:p1'); first.focus();
  context.appMessage({data: JSON.stringify({type: 'herd', herd: [two[0], {...two[1], status: 'blocked'}]})});
  assert.deepEqual(mirror.map((b) => b.getAttribute('data-id')), ['w9:p2', 'w9:p1']);
  assert.equal(document.activeElement, first);
  context.appMessage({data: JSON.stringify({type: 'herd', herd: [sheep('w9:p3', 'working'), two[0]]})});
  assert.equal(document.activeElement, first);
  context.appMessage({data: JSON.stringify({type: 'herd', herd: twelve})});
  world.opts.onMore();
  const more = items.children[1].children[0]; more.focus();
  context.appMessage({data: JSON.stringify({type: 'herd', herd: twelve.filter((s) => s.id !== 'w2:p8')})});
  assert.equal(document.activeElement, more); assert.equal(items.children[0].children[0], more);
  document.getElementById('herdlistclose').click();
  console.log('PASS: mirror and list buttons keep their nodes across polls; focus survives, even across a rebuild');

  // B closes the top panel like Escape, except while a text field has focus.
  context.appMessage({data: JSON.stringify({type: 'herd', herd: twelve})});
  world.opts.onMore();
  typed.focus(); document.events.keydown({key: 'b', preventDefault() {}});
  assert.equal(list.hidden, false);
  document.getElementById('herdlistclose').focus(); document.events.keydown({key: 'b', preventDefault() {}});
  assert.equal(list.hidden, true);
  world.opts.onSheep('w1:p1'); await H.settle();
  document.events.keydown({key: 'B', preventDefault() {}});
  assert.equal(panel.hidden, true);
  console.log('PASS: B closes the top panel unless typing');

  // Panel headings and focus rings contrast with the paper (4.5:1 and a visible ring).
  const css = H.html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /\.pane h3 \{[^}]*color: var\(--ink\)/);
  assert.match(css, /\.action:focus-visible \{ outline: 3px solid var\(--ink\)/);
  console.log('PASS: panel headings and focus rings use the ink shade');

  // Off call the page polls api/herd beside api/show and feeds the world.
  H.reset();
  replies['api/herd'] = {ok: true, json: async () => ({herd: [sheep('w5:p1', 'working')]})};
  H.load('?view&plain');
  await H.settle();
  assert.equal(fetches.some((f) => f.url === 'api/herd'), true);
  assert.deepEqual(ids(last('setHerd')[1].field), ['w5:p1']);
  console.log('PASS: off-call herd poll');

  // ?demo=12 places eight and a +4 with no network.
  H.reset();
  H.load('?view&demo=12');
  await H.advance(3000);
  assert.equal(fetches.length, 0);
  const demo = last('setHerd')[1];
  assert.equal(demo.field.length + demo.gate.length + demo.home.length, 8); assert.equal(demo.more, 4);
  console.log('PASS: demo=12 shows 8 + 4 offline');

  // A 7-agent `herdr agent list` (the desk and six tabs, the live mix of 2026-11-07: five resting at their prompt, one
  // finished) runs through the bridge's real herd_of and lands on the page as six drawn sheep, none hidden as a count.
  const agent = (n, name, status) => ({agent: 'claude', agent_session: {value: 'sid-' + n}, agent_status: status, name,
    pane_id: 'w4:p' + n, tab_id: 'w4:t' + n, terminal_title_stripped: name + ' brief', workspace_id: 'w4'});
  const listed = [agent('A', 'shepherd-1793925526', 'idle'), agent('B', 'handoff-rapid-fire-1793929809', 'idle'),
    agent('C', 'b1793973905-1dcef3-docs-update-c', 'idle'), agent('D', 'b1793999550-eb86ba-paper-test-x', 'idle'),
    agent('E', 'b1794007224-3b89ed-api-refactor', 'idle'), agent('M', 'desk', 'working'), agent('V', 'today-182-1794061326', 'done')];
  const py = 'import json, sys; sys.path.insert(0, sys.argv[1]); import bridge as o; a = json.load(sys.stdin); ' +
    'print(json.dumps(o.herd_of(a, next(x for x in a if x["name"] == o.NAME))))';
  const bridged = JSON.parse(require('node:child_process').execFileSync('python3', ['-I', '-c', py, __dirname], {input: JSON.stringify(listed), timeout: 30000}));
  assert.equal(bridged.length, 6);
  H.reset();
  replies['api/herd'] = {ok: true, json: async () => ({herd: bridged})};
  H.load('?view&plain');
  await H.settle();
  const seven = last('setHerd')[1];
  const drawn = [...seven.field, ...seven.gate, ...seven.home, ...seven.rest];
  assert.equal(drawn.length, 6); assert.equal(seven.more, 0);
  assert.deepEqual(drawn.map((s) => s.id).sort(), ['w4:pA', 'w4:pB', 'w4:pC', 'w4:pD', 'w4:pE', 'w4:pV']);
  assert.equal(document.getElementById('herdbuttons').children.length, 6);
  assert.equal(document.getElementById('herdmore').children.length, 0);
  // a failing card fetch does not hold the herd back
  H.reset();
  replies['api/show'] = () => Promise.reject(new Error('offline'));
  replies['api/herd'] = {ok: true, json: async () => ({herd: bridged})};
  H.load('?view&plain');
  await H.settle();
  assert.equal([...last('setHerd')[1].rest, ...last('setHerd')[1].home].length, 6);
  console.log('PASS: a 7-agent herdr list through herd_of draws 6 sheep (5 resting, 1 finished); a failed card poll keeps the herd');

  // Leaving and reopening the app (the phone app builds a fresh WebView): the thread, the open card, the open sheep with a
  // Text aimed at it, the half-typed line and the herd come back; a line cut off mid-reveal comes back whole.
  const saved = new Map();
  const storage = {getItem: (k) => (saved.has(k) ? saved.get(k) : null), setItem: (k, v) => saved.set(k, String(v))};
  H.reset();
  replies['api/herd'] = {ok: true, json: async () => ({herd: bridged})};
  let ctx = H.load('?plain', {localStorage: storage});
  await H.settle();
  ctx.appMessage({data: JSON.stringify({type: 'heard', text: 'How are the tabs?'})});
  ctx.bubble.say('Five are resting and one is finished.', {paced: false});
  await H.advance(20000);
  ctx.bubble.say('This sentence is cut off when he leaves the app.', {paced: false});
  await H.advance(400);
  ctx.appMessage({data: JSON.stringify({type: 'show', id: 'card-1', text: 'Here is the report.'})});
  world.opts.onSheep('w4:pC'); await H.settle();
  document.getElementById('herdtext').click();
  document.getElementById('typed').value = 'half a thought';
  document.getElementById('typed').events.input();
  const thread = () => document.getElementById('lines').children.map((li) => li.children.find((c) => c.classes.has('words')).textContent);
  assert.notEqual(thread().at(-1), 'This sentence is cut off when he leaves the app.');  // still revealing
  H.reset();
  replies['api/show'] = {ok: true, json: async () => ({type: 'show', id: 'card-1', text: 'Here is the report.'})};
  ctx = H.load('?plain', {localStorage: storage});
  assert.deepEqual(thread(), ['How are the tabs?', 'Five are resting and one is finished.', 'This sentence is cut off when he leaves the app.']);
  assert.deepEqual(document.getElementById('lines').children.map((li) => ['desk', 'sheep', 'you'].find((k) => li.classes.has(k))), ['you', 'desk', 'desk']);
  assert.equal(document.getElementById('card').hidden, false);
  assert.equal(document.getElementById('cardtext').textContent, 'Here is the report.');
  assert.equal(document.getElementById('herd').hidden, false);
  assert.equal(document.getElementById('herdname').textContent, 'docs-update-c');
  assert.equal(document.getElementById('typed').getAttribute('placeholder'), 'Type to docs-update-c');
  assert.equal(document.getElementById('typed').value, 'half a thought');
  assert.equal([...last('setHerd')[1].rest, ...last('setHerd')[1].home].length, 6);  // before the first poll answers
  // a dismissed card stays dismissed across a reopen, even though the desk's latest card is still that one
  document.getElementById('dismiss').click();
  document.getElementById('herdclose').click();
  H.reset();
  replies['api/show'] = {ok: true, json: async () => ({type: 'show', id: 'card-1', text: 'Here is the report.'})};
  ctx = H.load('?plain', {localStorage: storage});
  await H.advance(7000);
  assert.equal(document.getElementById('card').hidden, true);
  assert.equal(document.getElementById('herd').hidden, true);
  assert.equal(thread().length, 3);
  // junk in storage is ignored, and the demo neither reads nor writes it
  saved.set('sheprd.page.v1', '{not json');
  H.reset(); H.load('?plain', {localStorage: storage}); await H.settle();
  assert.equal(document.getElementById('lines').children.length, 0);
  const before2 = saved.get('sheprd.page.v1');
  H.reset(); H.load('?view&demo', {localStorage: storage}); await H.advance(3000);
  assert.equal(saved.get('sheprd.page.v1'), before2);
  console.log('PASS: leaving and reopening keeps the thread (cut-off lines whole), card, sheep panel, Text target, draft and herd; dismissed cards stay dismissed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
