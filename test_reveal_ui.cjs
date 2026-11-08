// node test_reveal_ui.cjs: reply-local reveal using the real controller, DOM handlers and a fake clock/audio.
const assert = require('node:assert/strict');
const H = require('./ui_harness.cjs');
const {document, newest, advance, settle} = H;

(async () => {
  const c = H.load('?plain');
  await settle();
  const peer = {connectionState: 'connected', close() { throw new Error('reveal closed the call'); }};
  c.probe.pc = peer;
  const voice = document.getElementById('voice'), mic = {enabled: true};
  voice.srcObject = {id: 'remote-voice'}; voice.paused = false; voice.currentTime = 2;
  voice.pause = voice.play = () => { throw new Error('reveal changed audio playback'); };
  c.probe.mic = {getTracks: () => [mic], getAudioTracks: () => [mic]};
  const event = (type, props = {}) => c.appMessage({data: JSON.stringify({type, ...props})});
  const say = (text, speaker = null) => event('say', {text, speaker});
  const user = () => event('heard', {text: 'Another question.'});

  say('One two three four five six.');
  assert.equal(newest().words, 'One');
  await advance(350);
  assert.equal(newest().words, 'One two', 'no tap keeps the word clock');
  const first = newest().li, requests = H.fetches.length;
  assert.equal(first.getAttribute('role'), 'button');
  assert.equal(first.getAttribute('tabindex'), '0');
  first.click();  // a real portrait click bubbles to this same li (covered by the phone render)
  assert.equal(newest().words, 'One two three four five six.');
  assert.equal(first.getAttribute('role'), null);
  await advance(1000);
  assert.equal(newest().words, 'One two three four five six.', 'a stale timer cannot shorten it');
  say('The rest of this reply arrives in full.');
  assert.equal(newest().li, first);
  assert.equal(newest().words, 'One two three four five six. The rest of this reply arrives in full.');
  event('said');
  assert.equal(c.probe.pc, peer); assert.equal(mic.enabled, true);
  assert.equal(voice.srcObject.id, 'remote-voice'); assert.equal(voice.paused, false); assert.equal(voice.currentTime, 2);
  assert.equal(H.fetches.length, requests, 'reveal sends no network or speech command');
  console.log('PASS: tap reveals current and later sentences in the same reply; no tap is paced; speech, mic and connection untouched');

  user(); say('New reply still types normally.');
  const second = newest().li;
  assert.equal(newest().words, 'New');
  first.click();
  assert.equal(newest().words, 'New', 'older boxes cannot reveal a different reply');
  let prevented = false;
  second.events.keydown({key: ' ', preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  assert.equal(newest().words, 'New reply still types normally.');
  await advance(16000);
  say('After a quiet gap words type.');
  assert.equal(newest().words, 'After');
  const active = newest().li;
  user(); active.click();
  assert.equal(active.children.find((el) => el.classes.has('words')).textContent, 'After a quiet gap words type.', 'the speaking bubble still reveals if his next line is newer');
  event('say-stop'); say('After an interruption words type.');
  assert.equal(newest().words, 'After');
  console.log('PASS: reveal resets on a new turn, quiet gap or interruption; old boxes do nothing; keyboard reveal works');

  c.grip.set(0);
  const corner = document.getElementById('corner');
  corner.click();
  assert.equal(newest().words, 'After an interruption words type.');
  assert.equal(document.getElementById('screen').classes.has('chatoff'), false, 'corner tap opens the revealed reply');
  user(); say('Keyboard on the corner works too.'); c.grip.set(0);
  corner.events.keydown({key: 'Enter', preventDefault() {}});
  assert.equal(newest().words, 'Keyboard on the corner works too.');
  console.log('PASS: corner portrait tap and Enter show the whole reply and reopen hidden chat');

  user(); say('World icon reveals without hanging up.');
  const screen = document.getElementById('screen'); screen.classList.add('speaking');
  H.world.opts.onShepherd(); H.world.opts.onShepherd();
  assert.equal(newest().words, 'World icon reveals without hanging up.');
  assert.equal(c.probe.pc, peer);
  assert.doesNotMatch(document.getElementById('status').textContent, /again to hang up/);
  screen.classList.remove('speaking');
  event('herd', {herd: [{id: 'w1:p1', name: 'api', status: 'working', talk: true}]});
  event('speaker', {id: 'w1:p1', name: 'api'});
  say('Different speaker starts paced.', 'api');
  assert.equal(newest().words, 'Different');
  newest().li.click();
  assert.equal(newest().words, 'Different speaker starts paced.');
  console.log('PASS: repeated world-icon taps during speech never hang up; a different speaker starts paced');

  // A tap shows the whole reply, not just the sentence playing: the page asks the call ("reveal"), the call answers
  // with the reply's sentences the voice has not reached, and each later "say" of one shows it once, not again.
  H.reset();
  const store = {};
  const live = H.load('?plain', {localStorage: {getItem() { return null; }, setItem(k, v) { store[k] = v; }}}); await settle();
  const sent = [];
  live.probe.pc = peer; live.probe.events = {readyState: 'open', send(text) { sent.push(JSON.parse(text)); }};
  const ev = (type, props = {}) => live.appMessage({data: JSON.stringify({type, ...props})});
  ev('say', {text: 'First of four.', speaker: null});
  assert.equal(newest().words, 'First');
  newest().li.click();
  assert.deepEqual(sent, [{type: 'reveal'}], 'the tap asks the call for the rest of the reply');
  ev('reveal', {sentences: ['Second of four.', 'Third of four.', 'Fourth of four?']});
  const full = 'First of four. Second of four. Third of four. Fourth of four?';
  assert.equal(newest().words, full, 'the whole reply shows at once');
  ev('said'); ev('say', {text: 'Second of four.', speaker: null});
  assert.equal(newest().words, full, 'a revealed sentence the voice reaches is not shown twice');
  ev('said'); ev('say', {text: 'Third of four.', speaker: null});
  ev('reveal', {sentences: ['Fifth came later.']});  // the desk wrote more while the voice reads on
  assert.equal(newest().words, full + ' Fifth came later.');
  ev('said'); ev('say', {text: 'Fourth of four?', speaker: null}); ev('said'); ev('say', {text: 'Fifth came later.', speaker: null}); ev('said');
  assert.equal(newest().words, full + ' Fifth came later.', 'every sentence shown exactly once after the voice read them all');
  assert.equal(JSON.parse(store['sheprd.page.v1']).thread.at(-1).text, full + ' Fifth came later.', 'the saved reply is the spoken text, once');
  assert.equal(H.boxes(), 1, 'one box for the reply');
  console.log('PASS: on a call a tap shows the whole multi-sentence reply; later sentences are shown once as the voice reads them');

  live.appMessage({data: JSON.stringify({type: 'heard', text: 'Another question.'})});
  ev('say', {text: 'One two three four.', speaker: null});
  newest().li.click();
  ev('reveal', {sentences: ['Never spoken.']});
  assert.equal(newest().words, 'One two three four. Never spoken.');
  ev('say-stop', {heard: 'One two'}); ev('unspoken', {text: 'three four. Never spoken.'});
  const cutBox = newest().li;
  assert.equal(newest().words, 'One two', 'a cut keeps only what he heard in the reply text');
  assert.equal(cutBox.children.find((el) => el.classes.has('unspoken')).children[1].textContent, 'three four. Never spoken.', 'the rest shows once, marked not spoken');
  ev('reveal', {sentences: ['Stale.']});
  assert.equal(newest().words, 'One two', 'a late reveal after a cut changes nothing');
  console.log('PASS: a cut after a reveal shows the unheard rest once, under not spoken');

  H.reset();
  const off = H.load('?plain'); await settle();
  for (const text of ['First sentence here.', 'Second sentence here.', 'Third sentence here.']) off.bubble.say(text);
  assert.equal(off.bubble.queued, 2);
  newest().li.click();
  assert.equal(newest().words, 'First sentence here. Second sentence here. Third sentence here.');
  assert.equal(off.bubble.queued, 0);
  console.log('PASS: off-call tap flushes all received sentences of the same reply');
})().catch((e) => { console.error(e); process.exitCode = 1; });
