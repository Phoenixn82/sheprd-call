// Node-only check of the screen-aware context (Task 5b page part): opening a sheep panel on a call sends
// {"type": "context", "sheep": <id>} on the data channel, closing sends null; off call a typed turn with a panel open
// carries context.sheep in its /api/turn body. No browser, no network.
const assert = require('node:assert/strict');
const H = require('./ui_harness.cjs');
const {document, fetches, world, newest} = H;

(async () => {
  const context = H.load('');
  const herd = [{id: 'w4:pCF', name: 'api', title: 'Fix the api', status: 'working', talk: true},
                ...Array.from({length: 8}, (_, i) => ({id: 'w4:p' + (i + 2), name: 'web' + i, title: 'Web', status: 'idle', talk: true}))];
  context.appMessage({data: JSON.stringify({type: 'herd', herd})});

  // On a call: open sends the id, close sends null; opening another sheep sends its id; nothing else goes down the channel.
  const sent = [];
  context.probe.pc = {connectionState: 'connected', close() {}};
  context.probe.events = {readyState: 'open', send: (m) => sent.push(JSON.parse(m))};
  world.opts.onSheep('w4:pCF'); await H.settle();
  assert.deepEqual(sent, [{type: 'context', sheep: 'w4:pCF'}]);
  world.opts.onMore();  // the +N list over the panel: the open sheep is still the context
  document.getElementById('herdlistitems').children[0].children[0].click(); await H.settle();
  assert.deepEqual(sent.at(-1), {type: 'context', sheep: 'w4:p9'});
  document.getElementById('herdclose').click();
  assert.deepEqual(sent.at(-1), {type: 'context', sheep: null});
  assert.equal(sent.length, 3);
  // a typed desk turn on a call carries the open sheep too (the HTTP route does not read the channel's state)
  world.opts.onSheep('w4:pCF'); await H.settle();
  const typed = document.getElementById('typed'), form = document.getElementById('typebox');
  fetches.length = 0; typed.value = 'is this done?'; form.events.submit({preventDefault() {}}); await H.settle();
  assert.deepEqual(JSON.parse(fetches.find((f) => f.url === 'api/turn').body), {text: 'is this done?', typed: true, context: {sheep: 'w4:pCF'}});
  assert.equal(fetches.some((f) => f.url.startsWith('api/events')), false);  // the call carries the answer
  // R20 on a call: Text to a sheep follows that pane's stream, waits for ready, posts with `to`; its answer shows
  // silently in that sheep's box in the thread, never spoken through the call
  document.getElementById('herdtext').click();
  H.streams.length = 0; fetches.length = 0; typed.value = 'status?'; form.events.submit({preventDefault() {}}); await H.settle();
  const at = (u) => fetches.findIndex((f) => f.url === u);
  assert.ok(at('api/events?follow=w4%3ApCF') >= 0 && at('api/turn') < 0, fetches.map((f) => f.url).join());
  H.streams[0].push('{"ready": true}'); await H.settle();
  assert.deepEqual(JSON.parse(fetches.find((f) => f.url === 'api/turn').body), {text: 'status?', typed: true, to: 'w4:pCF'});
  H.streams[0].push('{"say": "Nearly done."}'); await H.settle(); await H.advance(100);
  assert.equal(context.bubble.who, 'w4:pCF'); assert.deepEqual([newest().kind, newest().who], ['sheep', 'api']);
  // hang up closes the panel and tells nothing (the channel is gone)
  context.hangup();
  assert.equal(document.getElementById('herd').hidden, true);
  assert.equal(sent.length, 4);
  console.log('PASS: on a call the panel sends context; typed turns carry it; Text to a sheep follows its stream');

  // Off call: a typed turn with a panel open posts context.sheep = that id; with none open there is no context.
  context.probe.pc = null; context.probe.events = null;
  fetches.length = 0;
  world.opts.onSheep('w4:pCF'); await H.settle();
  typed.value = 'how about this one'; form.events.submit({preventDefault() {}}); await H.settle();
  H.streams.at(-1).push('{"ready": true}'); await H.settle();
  assert.deepEqual(JSON.parse(fetches.find((f) => f.url === 'api/turn').body),
    {text: 'how about this one', typed: true, context: {sheep: 'w4:pCF'}});
  // a desk turn with context, not a turn to the sheep
  assert.ok(at('api/events?follow=desk') >= 0 && at('api/events?follow=desk') < at('api/turn'), fetches.map((f) => f.url).join());
  document.getElementById('herdclose').click();
  fetches.length = 0; typed.value = 'plain'; form.events.submit({preventDefault() {}}); await H.settle();
  H.streams.at(-1).push('{"ready": true}'); await H.settle();
  assert.deepEqual(JSON.parse(fetches.find((f) => f.url === 'api/turn').body), {text: 'plain', typed: true});
  // Text to the sheep itself carries `to`, never a context note
  world.opts.onSheep('w4:pCF'); await H.settle();
  document.getElementById('herdtext').click();
  fetches.length = 0; typed.value = 'to you'; form.events.submit({preventDefault() {}}); await H.settle();
  H.streams.at(-1).push('{"ready": true}'); await H.settle();
  assert.deepEqual(JSON.parse(fetches.find((f) => f.url === 'api/turn').body), {text: 'to you', typed: true, to: 'w4:pCF'});
  console.log('PASS: off call a typed turn carries context.sheep while a panel is open');
})().catch((error) => { console.error(error); process.exitCode = 1; });
