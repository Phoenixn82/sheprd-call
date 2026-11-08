// Node-only check of the thread (the RPG text boxes under the world), the sprite states, the layout rule and the text box; no
// browser, no network. The page script runs in the shared vm harness (fake document, fake clock, timer queue, fake
// SheprdWorld recording every call), so word timing and the 2-minute off-call stream rule are exact.
const assert = require('node:assert/strict');
const H = require('./ui_harness.cjs');
const {document, fetches, streams, world, last, newest, boxes, plain, advance, settle} = H;

(async () => {
  const context = H.load('');
  // Pure schedule: one entry per word; with secs the words spread evenly over secs.
  assert.deepEqual(plain(context.bubbleReveal('one two three', null, 2)),
    [{at: 0, shown: 'one'}, {at: 0.5, shown: 'one two'}, {at: 1, shown: 'one two three'}]);
  assert.deepEqual(plain(context.bubbleReveal('a b', 4).map((w) => w.at)), [0, 2]);
  assert.deepEqual(plain(context.bubbleReveal('', null)), []);
  assert.deepEqual(plain(context.bubbleReveal('   ', 3)), []);
  assert.equal(plain(context.bubbleReveal('a b', null))[1].at, 1 / 3.2);  // the default pace is WORDS_PER_SEC
  console.log('PASS: bubbleReveal schedule (4 checks)');

  // Sprite state priority: aside > talking > listening > thinking > idle.
  assert.equal(context.spriteState({busy: true}), 'thinking');
  assert.equal(context.spriteState({busy: true, speaking: true}), 'talking');
  assert.equal(context.spriteState({listening: true}), 'listening');
  assert.equal(context.spriteState({listening: true, busy: true}), 'listening');
  assert.equal(context.spriteState({aside: true, speaking: true}), 'aside');
  assert.equal(context.spriteState({}), 'idle');
  console.log('PASS: spriteState priority (6 checks)');

  // The page mounted the world once on #world with its callbacks, and told it the sprite state.
  assert.equal(world.calls.filter((c) => c[0] === 'mount').length, 1);
  assert.equal(world.el, document.getElementById('world'));
  for (const cb of ['onSheep', 'onMore', 'onGround', 'onShepherd']) assert.equal(typeof world.opts[cb], 'function', cb);
  assert.equal(typeof world.opts.reducedMotion, 'boolean');
  assert.deepEqual(last('setSprite').slice(1), ['idle']);
  console.log('PASS: world mounted with callbacks; sprite state told');

  // A say opens a new box in the thread and reveals its words on the clock (desk box, plate SHEPRD, a live advance mark,
  // the portrait by expression); say-stop freezes it where it is; said completes it and mirrors it; boxes stay for
  // reading back, newest last, and the thread follows the newest while he is at the bottom.
  const live = document.getElementById('bubblelive'), lines = document.getElementById('lines'), newer = document.getElementById('newer');
  const scrn = document.getElementById('screen');
  assert.equal(boxes(), 0); assert.equal(scrn.classes.has('talk'), false);
  context.probe.pc = {connectionState: 'connected'};
  context.appMessage({data: JSON.stringify({type: 'say', text: 'one two three four', speaker: null})});
  assert.equal(boxes(), 1); assert.equal(scrn.classes.has('talk'), true);
  let d = newest();
  assert.deepEqual([d.kind, d.who, d.words, d.live], ['desk', 'SHEPRD', 'one', true]);
  assert.ok(['shepherd-neutral', 'shepherd-talk1', 'shepherd-talk2'].includes(d.face), d.face);
  await advance(700);  // 3.2 words/s: the third word lands at 625 ms
  assert.equal(newest().words, 'one two three');
  context.appMessage({data: JSON.stringify({type: 'say-stop'})});
  await advance(5000);
  d = newest();
  assert.deepEqual([d.words, d.live, boxes()], ['one two three', false, 1]);  // frozen where it was, and it stays
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Fine and dandy.', speaker: null})});
  assert.equal(boxes(), 2); assert.equal(newest().words, 'Fine');
  context.appMessage({data: JSON.stringify({type: 'said'})});
  assert.deepEqual([newest().words, newest().live, live.textContent], ['Fine and dandy.', false, 'Fine and dandy.']);
  assert.equal(lines.children[0].children.find((c) => c.classes.has('words')).textContent, 'one two three');  // the old box is still there to read
  assert.equal(lines.children[0].children.find((c) => c.classes.has('face')).hidden, true);  // only the newest box wears the portrait
  // the next sentence of the same reply lands in the same box, not a new one ("why do you make new talking bubbles
  // like every sentence stop that")
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Second sentence here.', speaker: null})});
  assert.equal(boxes(), 2); assert.equal(newest().words, 'Fine and dandy. Second');
  context.appMessage({data: JSON.stringify({type: 'said'})});
  assert.deepEqual([boxes(), newest().words, live.textContent], [2, 'Fine and dandy. Second sentence here.', 'Second sentence here.']);
  // following: a box growing far past the old 48 px slack (a portrait, wrapped lines) still keeps the newest in view
  const thread = document.getElementById('thread');
  thread.scrollHeight = 400; thread.clientHeight = 300; thread.scrollTop = 100; thread.events.scroll();
  thread.scrollHeight = 600;
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Grows a lot.', speaker: null})});
  assert.equal(thread.scrollTop, 600); assert.equal(newer.hidden, true);
  context.appMessage({data: JSON.stringify({type: 'said'})});
  // scrolled up to read back: new words do not yank him down; a Newest key waits; at the bottom again it follows
  thread.scrollHeight = 1000; thread.scrollTop = 700; thread.events.scroll(); thread.scrollTop = 0; thread.events.scroll();
  context.appMessage({data: JSON.stringify({type: 'say', text: 'More words.', speaker: null})});
  assert.equal(thread.scrollTop, 0); assert.equal(newer.hidden, false);
  newer.click();
  assert.equal(thread.scrollTop, 1000); assert.equal(newer.hidden, true);
  context.appMessage({data: JSON.stringify({type: 'said'})});
  thread.scrollTop = 200; thread.events.scroll(); thread.scrollTop = 700; thread.events.scroll();  // he scrolls back down by hand
  assert.equal(newer.hidden, true);
  thread.scrollHeight = 1100;
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Followed again.', speaker: null})});
  assert.equal(thread.scrollTop, 1100);
  context.appMessage({data: JSON.stringify({type: 'said'})});
  // a sentence after a long quiet is a new reply, so a new box
  const quietBoxes = boxes();
  await advance(16000);
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Later news.', speaker: null})});
  assert.equal(boxes(), quietBoxes + 1);
  context.appMessage({data: JSON.stringify({type: 'said'})});
  // what the call heard him say lands as his own box; his typed lines too (below)
  context.appMessage({data: JSON.stringify({type: 'heard', text: 'how is it going'})});
  assert.deepEqual([newest().kind, newest().who, newest().words, newest().face], ['you', 'You', 'how is it going', null]);
  context.appMessage({data: JSON.stringify({type: 'heard', text: '   '})});
  assert.equal(newest().words, 'how is it going');
  // with a sheep seated as the speaker, its lines carry that pane id and its name; the desk's own notices stay Sheprd's
  context.appMessage({data: JSON.stringify({type: 'herd', herd: [{id: 'w4:pCF', name: 'api', title: 'Fix', status: 'working', talk: true}]})});
  context.appMessage({data: JSON.stringify({type: 'speaker', id: 'w4:pCF', name: 'api'})});
  assert.deepEqual(last('setSprite').slice(1), ['aside']);
  context.appMessage({data: JSON.stringify({type: 'say', text: 'From the sheep.', speaker: 'api'})});
  d = newest();
  assert.deepEqual([context.bubble.who, d.kind, d.who, d.words, d.face], ['w4:pCF', 'sheep', 'api', 'From', 'sheep-neutral']);
  context.appMessage({data: JSON.stringify({type: 'say', text: 'web is done.', speaker: null})});
  assert.equal(context.bubble.who, 'shepherd'); assert.equal(newest().kind, 'desk');
  context.appMessage({data: JSON.stringify({type: 'speaker', id: null, name: null})});
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Back.', speaker: null})});
  assert.deepEqual([newest().who, context.bubble.who], ['SHEPRD', 'shepherd']);
  console.log('PASS: say opens a box and reveals into it, say-stop freezes, said completes and mirrors, boxes stay, scrollback holds, heard turns, speaker identity');

  // Portrait expressions on the newest box: thinking while busy, surprised when a sheep turns blocked, happy when one
  // turns done, worried on an error, talk1/talk2 on the voice level and neutral when silent.
  const face = () => newest().face;
  context.appMessage({data: JSON.stringify({type: 'busy', busy: true})});
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Hm let me see.', speaker: null})});
  assert.equal(face(), 'shepherd-thinking');
  context.appMessage({data: JSON.stringify({type: 'busy', busy: false})});
  context.appMessage({data: JSON.stringify({type: 'herd', herd: [{id: 'w4:pCF', name: 'api', title: 'Fix', status: 'blocked', talk: true}]})});
  assert.equal(face(), 'shepherd-surprised');
  await advance(3500);
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Calm again now.', speaker: null})});
  assert.notEqual(face(), 'shepherd-surprised');
  context.appMessage({data: JSON.stringify({type: 'herd', herd: [{id: 'w4:pCF', name: 'api', title: 'Fix', status: 'done', talk: true}]})});
  assert.equal(face(), 'shepherd-happy');
  await advance(3500);
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Oh no the push failed.', speaker: null})});
  context.showWarning('Call connection interrupted.');
  assert.equal(face(), 'shepherd-worried');
  context.showWarning('');
  await advance(3500);
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Talking on the level.', speaker: null})});
  context.sprite.level(2); await advance(130); context.sprite.level(2);
  assert.ok(face() === 'shepherd-talk1' || face() === 'shepherd-talk2', face());
  context.sprite.level(0);
  assert.equal(face(), 'shepherd-neutral');
  context.appMessage({data: JSON.stringify({type: 'said'})});
  await advance(5000);
  console.log('PASS: portrait expressions on busy, blocked, done, warning and the voice level');

  // The text box: on a call it posts a typed turn; an empty submit posts nothing.
  const typed = document.getElementById('typed'), form = document.getElementById('typebox');
  // Send sits inside the form, right after the text box; mute sits in the HUD beside the mic meter
  assert.match(H.html, /<form id="typebox"[^>]*>[\s\S]*?<input id="typed"[^>]*>\s*<button id="send" class="key" type="submit">Send<\/button>\s*<\/form>/);
  assert.match(H.html, /<div id="hud">[\s\S]*?<div id="mic">\s*<div id="miccheck">[\s\S]*?<\/div>\s*<button id="mute"[\s\S]*?<\/button>\s*<\/div>\s*<\/div>/);
  const submit = () => form.events.submit({preventDefault() {}});
  fetches.length = 0;
  typed.value = '   '; submit(); await settle();
  assert.equal(fetches.filter((f) => f.url === 'api/turn').length, 0);
  typed.value = 'hi'; submit(); await settle();
  const turn = fetches.find((f) => f.url === 'api/turn');
  assert.equal(turn.method, 'POST'); assert.deepEqual(JSON.parse(turn.body), {text: 'hi', typed: true});
  assert.equal(turn.headers['Content-Type'], 'application/json');  // the voice host refuses any other body type
  assert.equal(turn.headers['X-Sheprd'], '1');
  assert.ok(fetches.every(f => f.headers && f.headers['X-Sheprd'] === '1'), 'every page request carries X-Sheprd');
  assert.equal(typed.value, '');
  assert.deepEqual([newest().kind, newest().words], ['you', 'hi']);  // his typed line is a box of his own
  assert.equal(streams.length, 0);  // on a call the answer comes down the call itself
  console.log('PASS: text box posts a typed turn on a call, nothing when empty');

  // R16: off call, the page opens the events stream first, waits for ready, then posts; the stream lives through a
  // busy spell and closes only 2 minutes after the last line while not busy.
  context.probe.pc = null; fetches.length = 0;
  typed.value = 'later'; submit(); await settle();
  assert.equal(streams.length, 1); assert.equal(fetches[0].url, 'api/events?follow=desk');
  assert.equal(fetches.filter((f) => f.url === 'api/turn').length, 0, 'posted before ready');
  streams[0].push('{"ready": true}'); await settle();
  assert.deepEqual(JSON.parse(fetches.find((f) => f.url === 'api/turn').body), {text: 'later', typed: true});
  streams[0].push('{"busy": true}'); await settle();
  await advance(5 * 60 * 1000);
  assert.equal(streams[0].cancelled, false, 'closed while busy');
  streams[0].push('{"busy": false}'); streams[0].push('{"say": "Late answer here."}'); await settle();
  await advance(2000);
  assert.equal(newest().words, 'Late answer here.');
  await advance(2 * 60 * 1000 - 3000);  // 119 s after the last line
  assert.equal(streams[0].cancelled, false);
  await advance(1500);  // 120.5 s
  assert.equal(streams[0].cancelled, true, 'open 2 minutes after the last line');
  console.log('PASS: off-call typing follows the desk stream, waits for ready, survives busy, closes after 2 quiet minutes');

  // Three off-call sentences of one reply share one box, in order (the queue survives advancing).
  fetches.length = 0;
  const before = boxes();
  typed.value = 'three please'; submit(); await settle();
  const stream = streams[1]; stream.push('{"ready": true}'); await settle();
  for (const line of ['one two three', 'four five six', 'seven eight nine']) stream.push(JSON.stringify({say: line}));
  await settle(); await advance(1000);
  assert.equal(boxes(), before + 2);  // his typed line, then the desk's one box
  await advance(5000);
  assert.equal(newest().words, 'one two three four five six seven eight nine');
  assert.equal(boxes(), before + 2);
  console.log('PASS: three queued off-call sentences of one reply share one box, in order');

  // His turn split in two by speech recognition is one box; one thinking indicator: the pondering portrait in a waiting
  // box (his turn newest) or the newest Sheprd box, "Thinking." only to screen readers; the first sentence replaces
  // the waiting box; a busy spell with no answer leaves no empty box.
  context.probe.pc = {connectionState: 'connected'};
  const n0 = boxes();
  context.appMessage({data: JSON.stringify({type: 'heard', text: 'so the first half'})});
  context.appMessage({data: JSON.stringify({type: 'heard', text: 'and the second half'})});
  assert.deepEqual([boxes(), newest().kind, newest().words], [n0 + 1, 'you', 'so the first half and the second half']);
  const status = document.getElementById('status'), thinkLive = document.getElementById('thinklive');
  context.appMessage({data: JSON.stringify({type: 'busy', busy: true})});
  assert.deepEqual([boxes(), newest().li.classes.has('waiting'), newest().face, thinkLive.textContent], [n0 + 2, true, 'shepherd-thinking', 'Thinking.']);
  assert.notEqual(status.textContent, 'Thinking.');
  assert.ok(!/id="think"/.test(H.html), 'no separate thinking dots');
  context.appMessage({data: JSON.stringify({type: 'heard', text: 'oh and a third'})});  // he adds to his turn while it thinks
  assert.deepEqual([boxes(), newest().li.classes.has('waiting')], [n0 + 2, true]);
  assert.equal(lines.children.at(-2).children.find((c) => c.classes.has('words')).textContent, 'so the first half and the second half oh and a third');
  context.appMessage({data: JSON.stringify({type: 'say', text: 'Answer.', speaker: null})});
  assert.deepEqual([boxes(), newest().kind, newest().li.classes.has('waiting')], [n0 + 2, 'desk', false]);
  assert.equal(newest().face, 'shepherd-thinking');  // still busy and silent: the newest Sheprd box ponders
  context.appMessage({data: JSON.stringify({type: 'said'})});
  context.appMessage({data: JSON.stringify({type: 'busy', busy: false})});
  assert.equal(thinkLive.textContent, '');
  context.appMessage({data: JSON.stringify({type: 'heard', text: 'thanks'})});
  context.appMessage({data: JSON.stringify({type: 'busy', busy: true})}); context.appMessage({data: JSON.stringify({type: 'busy', busy: false})});
  assert.deepEqual([newest().kind, newest().words], ['you', 'thanks']);  // no empty box left behind
  console.log('PASS: his split turn is one box; thinking is the portrait in one waiting box, announced, gone without an answer');

  // Closed chat: the grip at 0 hides the thread and the portrait sits in the HUD's corner, following the mood.
  const grip = document.getElementById('grip'), corner = document.getElementById('corner');
  context.grip.set(0);
  assert.deepEqual([scrn.classes.has('chatoff'), grip.getAttribute('aria-valuenow'), grip.getAttribute('aria-valuetext')], [true, '0', 'Conversation hidden']);
  context.appMessage({data: JSON.stringify({type: 'busy', busy: true})});
  assert.equal(corner.getAttribute('data-face'), 'shepherd-thinking');
  context.appMessage({data: JSON.stringify({type: 'busy', busy: false})});
  assert.equal(corner.getAttribute('data-face'), 'shepherd-neutral');
  grip.events.keydown({key: 'ArrowUp', preventDefault() {}});
  assert.deepEqual([scrn.classes.has('chatoff'), grip.getAttribute('aria-valuenow')], [false, '15']);
  grip.events.keydown({key: 'ArrowDown', preventDefault() {}});
  assert.equal(scrn.classes.has('chatoff'), true);
  context.grip.set(40);
  console.log('PASS: the grip closes the chat and the portrait moves to the corner; arrow keys open and close it');

  // R22 on the world: the world is resized on every relayout. No 8-bit head corner (2026-11-07, the owner: "Yes" to
  // removing the tiny 8-bit guy beside the portrait): a panel open on a call leaves the sprite and the page as they are.
  document.getElementById('handoff').hidden = true; document.getElementById('herd').hidden = true; document.getElementById('herdlist').hidden = true;
  const screen = document.getElementById('screen');
  world.calls.length = 0;
  context.relayout();
  assert.equal(last('resize')[0], 'resize');
  assert.deepEqual(last('resize')[1], {right: 0, bottom: 0});
  context.innerWidth = 915; context.innerHeight = 412; context.relayout();
  assert.deepEqual(last('resize')[1], {right: 92, bottom: 70});  // css px: the world converts them with its own zoom
  context.probe.pc = {connectionState: 'connected'}; document.getElementById('card').hidden = false; context.relayout();
  assert.equal(screen.classes.has('compact'), false);
  assert.ok(world.calls.filter((c) => c[0] === 'setSprite').every((c) => c.length === 2), 'setSprite takes the state only');
  document.getElementById('card').hidden = true; context.relayout();
  context.probe.pc = null;
  console.log('PASS: no head corner while a panel is open on a call; world resized on relayout');

  // Without SheprdWorld (no Phaser) the page still runs: the thread carries the words and no world call is made.
  H.reset();
  const bare = H.load('', {SheprdWorld: undefined});
  bare.appMessage({data: JSON.stringify({type: 'say', text: 'No engine here.', speaker: null})});
  assert.equal(newest().words, 'No');
  assert.equal(world.calls.length, 0);
  console.log('PASS: page works without the world');

  // ?demo never touches the network and shows the fixed herd.
  await settle();  // let the bare page's poll schedule its next tick before reset drops it
  H.reset();
  H.load('?view&demo');
  await advance(10000);
  assert.equal(fetches.length, 0);
  const demo = last('setHerd')[1];
  assert.equal(demo.field.length + demo.gate.length + demo.home.length + demo.rest.length, 6);
  assert.ok(boxes() >= 4, 'the demo thread has a sample exchange');
  console.log('PASS: demo is offline with a six-sheep herd and a thread');

  // The keyboard: where the browser only shrinks and pans the visual viewport, the page is pinned to it (HUD at the
  // visible top, type box on the keyboard); closed again, the page is back to the full screen; pinch zoom is left alone.
  H.reset();
  const vv = {scale: 1, height: 915, offsetTop: 0, on: {}, addEventListener(n, f) { this.on[n] = f; }};
  const kb = H.load('?plain', {visualViewport: vv});
  const app = document.getElementById('app');
  vv.height = 520; vv.offsetTop = 395; vv.on.resize();
  assert.deepEqual([app.style.height, app.style.transform], ['520px', 'translateY(395px)']);
  vv.offsetTop = 0; vv.on.scroll();
  assert.deepEqual([app.style.height, app.style.transform], ['520px', '']);
  vv.height = 915; vv.on.resize();
  assert.deepEqual([app.style.height, app.style.transform], ['', '']);
  vv.scale = 2; vv.height = 300; vv.offsetTop = 100; vv.on.scroll();
  assert.equal(app.style.height, '');
  assert.match(H.html, /<meta name="viewport" content="[^"]*interactive-widget=resizes-content/);
  void kb;
  console.log('PASS: keyboard: the page follows the visual viewport so the HUD stays at the top and the type box on the keys');

  // A busy event must never cover the world. Only the PLAY sign/mirror opens a game; closing it restores the world
  // without removing the thread. A new busy event and dismissing a card must not bring it back.
  H.reset();
  const optional = H.load('?plain');
  optional.probe.pc = {connectionState: 'connected'};
  optional.appMessage({data: JSON.stringify({type: 'heard', text: 'Keep the world in view'})});
  optional.thinking(true);
  assert.equal(optional.game.on(), false);
  world.opts.onProp('games');
  assert.equal(optional.game.on(), true);
  optional.game.jump();
  document.getElementById('gameclose').click();
  assert.equal(optional.game.on(), false);
  const kept = document.getElementById('lines').children;  // his line stays; the thinking box waits after it
  assert.equal(kept.at(-2).children.find((c) => c.classes.has('words')).textContent, 'Keep the world in view');
  assert.ok(newest().li.classes.has('waiting'));
  optional.thinking(false); optional.thinking(true);
  optional.showCard({type: 'show', id: 'optional', text: 'A card'}); optional.dismissCard();
  assert.equal(optional.game.on(), false);
  document.getElementById('gamesopen').click();
  document.events.keydown({key: 'Escape', preventDefault() {}});
  assert.equal(optional.game.on(), false);
  assert.equal(document.activeElement, document.getElementById('gamesopen'));
  console.log('PASS: games open only by choice, close mid-run or with Escape, restore the world and keep the thread');

  // The phone launcher enters ?view in a WebView without mic permission. Navigate to call?auto so the phone app opens its
  // call screen; never request a mic in the viewer. Plain and demo pages remain quiet.
  for (const search of ['?view', '?view&plain', '?plain', '?view&demo']) {
    H.reset();
    const assigned = [];
    let captures = 0;
    H.load(search, {location: {search, assign: url => assigned.push(url)},
      navigator: {mediaDevices: {getUserMedia() { captures++; throw new Error('viewer requested a mic'); }}}});
    assert.deepEqual(assigned, search === '?view' ? ['call?auto'] : [], search);
    assert.equal(captures, 0, search);
    await settle();
  }
  console.log('PASS: opening the Sheprd viewer enters the mic-owning call screen; plain and demo stay quiet');

  // Opening the real call page requests audio and negotiates an offer without a tap. Exercise permission errors,
  // ending and calling again too: an earlier attempt must not leave the call button disabled or the mic waiting.
  for (const search of ['', '?auto']) {
    H.reset();
    const tracks = [], peers = [], constraints = [];
    let denied = false;
    const navigator = {mediaDevices: {async getUserMedia(opts) {
      constraints.push(opts);
      if (denied) throw Object.assign(new Error('denied'), {name: 'NotAllowedError'});
      const track = {enabled: true, readyState: 'live', addEventListener() {}, stop() { this.readyState = 'ended'; }};
      tracks.push(track); return {getTracks: () => [track], getAudioTracks: () => [track]};
    }}};
    class Peer {
      constructor() { peers.push(this); this.iceGatheringState = 'complete'; }
      addTrack(t) { this.track = t; }
      createDataChannel() { return {readyState: 'open'}; }
      async createOffer() { return {type: 'offer', sdp: 'test-offer'}; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription(d) { this.answer = d; this.connectionState = 'connected'; this.onconnectionstatechange(); }
      close() { this.connectionState = 'closed'; }
    }
    class AudioContext {
      constructor() { this.state = 'running'; }
      createAnalyser() { return {fftSize: 512, getFloatTimeDomainData() {}}; }
      createMediaStreamSource() { return {connect() {}}; }
      async close() {}
    }
    H.replies['api/offer'] = {ok: true, json: async () => ({type: 'answer', sdp: 'test-answer'})};
    const callPage = H.load(search, {navigator, RTCPeerConnection: Peer, window: {AudioContext}});
    await settle();
    assert.equal(constraints.length, 1, search);
    assert.deepEqual(plain(constraints[0]), {audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: false}, video: false});
    assert.equal(peers[0].track, tracks[0]);
    assert.deepEqual(plain(peers[0].answer), {type: 'answer', sdp: 'test-answer'});
    assert.equal(document.getElementById('heard').textContent, 'Mic live');
    assert.match(document.getElementById('status').textContent, /^You're on/);
    assert.equal(document.getElementById('mute').disabled, false);
    const offer = fetches.find(f => f.url === 'api/offer');
    assert.equal(offer.headers['X-Sheprd'], '1');
    assert.deepEqual(JSON.parse(offer.body), {sdp: 'test-offer', type: 'offer'});
    callPage.hangup();
    assert.equal(tracks[0].readyState, 'ended');
    assert.equal(document.getElementById('heard').textContent, 'Mic off');
    denied = true; await callPage.call();
    assert.equal(document.getElementById('heard').textContent, 'Mic blocked');
    assert.match(document.getElementById('status').textContent, /microphone is blocked/);
    assert.equal(document.getElementById('btn').disabled, false);
    denied = false; await callPage.call();
    assert.equal(callPage.probe.pc.connectionState, 'connected');
    assert.equal(document.getElementById('heard').textContent, 'Mic live');
    callPage.hangup(); await settle();
  }
  console.log('PASS: auto-call captures the mic, negotiates WebRTC, reports live/blocked/off and reconnects after ending or denial');

  // The loading screen: drawn by its own inline script at the top of <body> (never by the page script, so a live UI
  // update cannot add it to a running page); the page lowers it when there is nothing to wait for or the call is up or
  // has ended, and raises it again while a dropped call reconnects. ?demo&boot keeps it up.
  assert.match(H.html, /<body>\s*<script id="bootfx">[\s\S]*?insertAdjacentHTML\("afterend", '<div id="boot" aria-hidden="true">/);
  assert.match(H.html, /prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.equal(/<div id="boot"/.test(H.html.replace(/<script[\s\S]*?<\/script>/g, '')), false);
  const bootCalls = [], fakeBoot = {on: (t) => bootCalls.push(['on', t]), say: () => {}, off: () => bootCalls.push(['off'])};
  for (const [search, lowered] of [['?plain', true], ['?view&demo', true], ['?view&demo&boot', false]]) {
    H.reset(); bootCalls.length = 0; H.load(search, {sheprdBoot: fakeBoot}); await settle();
    assert.equal(bootCalls.some((c) => c[0] === 'off'), lowered, search);
  }
  H.reset(); bootCalls.length = 0;
  const page = H.load('?plain', {sheprdBoot: fakeBoot}); await settle();
  bootCalls.length = 0;
  page.hangup('Connection dropped. Tap me to reconnect.', true);
  assert.deepEqual(bootCalls, [['off']]);
  bootCalls.length = 0; page.call(); await settle();
  assert.deepEqual(bootCalls[0], ['on', 'Reconnecting to your desk…']);
  bootCalls.length = 0; page.call(); await settle();  // a plain retry after that is not a reconnect
  assert.equal(bootCalls.some((c) => c[0] === 'on'), false);
  console.log('PASS: loading screen up at first paint, lowered when nothing waits or the call settles, raised while a dropped call reconnects');
})().catch((error) => { console.error(error); process.exitCode = 1; });
