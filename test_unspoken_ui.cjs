// node test_unspoken_ui.cjs: when he cuts in, the whole reply stays in the thread (2026-11-07: "paste the rest of what
// you were saying while I'm cutting you off ... I can go back and read"): the words he heard in the box, the rest dimmed
// behind a "not spoken" tag (bot.py sends say-stop {heard} and then "unspoken"), kept across leaving the app.
const assert = require('node:assert/strict');
const H = require('./ui_harness.cjs');
const {document, newest, advance, settle} = H;

const unspokenOf = (li) => {  // {tag, words} of the box's not-spoken part, or null
  const p = li.children.find((c) => c.classes.has('unspoken'));
  if (!p) return null;
  const [tag, words] = p.children;
  return {tag: tag.classes.has('tag') && tag.textContent, words: words.textContent};
};

(async () => {
  let saved = null;
  const storage = {getItem() { return saved; }, setItem(_, v) { saved = v; }};
  const c = H.load('', {localStorage: storage});
  await settle();
  c.probe.pc = {connectionState: 'connected', close() {}};
  const event = (type, props = {}) => c.appMessage({data: JSON.stringify({type, ...props})});

  event('say', {text: 'First sentence was heard.'}); event('said');
  event('say', {text: 'One two three four five six.'});
  await advance(200);
  const box = newest().li;
  event('say-stop', {heard: 'One two three'});  // the bot's count of what he heard, the one the desk's note gives
  assert.equal(newest().words, 'First sentence was heard. One two three', 'the box keeps the words he heard');
  assert.equal(c.bubble.running, false, 'speech stopped at the cut');
  event('unspoken', {text: 'four five six. A held sentence.'});
  assert.equal(newest().li, box, 'the rest joins the cut reply, not a new box');
  assert.deepEqual(unspokenOf(box), {tag: 'not spoken', words: 'four five six. A held sentence.'});
  assert.equal(newest().words, 'First sentence was heard. One two three', 'the heard words stay unmarked');
  event('heard', {text: 'Wait, stop.'});
  assert.equal(newest().kind, 'you');
  event('unspoken', {text: 'Written before the desk read him.'});  // muted desk text: still the cut reply's rest
  assert.equal(newest().kind, 'you', 'his box stays the newest');
  assert.deepEqual(unspokenOf(box), {tag: 'not spoken', words: 'four five six. A held sentence. Written before the desk read him.'});
  event('say', {text: 'The answer to him.'});
  assert.notEqual(newest().li, box);
  assert.equal(newest().words, 'The', 'the next reply is a new paced box');
  assert.equal(unspokenOf(newest().li), null, 'a spoken reply carries no not-spoken mark');
  event('said');
  console.log('PASS: a cut reply keeps the heard words, then the rest dimmed with a "not spoken" tag; later muted text joins it; the next reply is clean');

  const lines = JSON.parse(saved).thread;
  assert.deepEqual(lines.find((l) => l.unspoken), {kind: 'desk', name: 'SHEPRD', text: 'First sentence was heard. One two three',
    unspoken: 'four five six. A held sentence. Written before the desk read him.'});
  H.reset();
  H.load('', {localStorage: storage});
  await settle();
  const back = document.getElementById('lines').children.find((li) => unspokenOf(li));
  assert.ok(back, 'the not-spoken part survives leaving the app');
  assert.equal(back.children.find((x) => x.classes.has('words')).textContent, 'First sentence was heard. One two three');
  assert.deepEqual(unspokenOf(back), {tag: 'not spoken', words: 'four five six. A held sentence. Written before the desk read him.'});
  console.log('PASS: the not-spoken part is saved and restored with the thread');

  H.reset(); saved = null;
  const d = H.load('', {localStorage: storage});
  await settle();
  d.probe.pc = {connectionState: 'connected', close() {}};
  const ev = (type, props = {}) => d.appMessage({data: JSON.stringify({type, ...props})});
  ev('say', {text: 'An old reply.'}); ev('said');
  ev('heard', {text: 'He talks while the desk writes.'});
  ev('unspoken', {text: 'A reply he talked over before a word was said.'});
  assert.equal(newest().kind, 'desk');
  assert.equal(newest().words, '', 'nothing of it was heard');
  assert.deepEqual(unspokenOf(newest().li), {tag: 'not spoken', words: 'A reply he talked over before a word was said.'});
  ev('say-stop');  // a stop with no count (a talker switch) freezes at the words shown, as before
  ev('say', {text: 'Next.'});
  assert.equal(unspokenOf(newest().li), null);
  assert.match(H.html, /\.line \.unspoken \{[^}]*color: #456b50/, 'dimmed in a shade that keeps 4.5:1 on paper');
  console.log('PASS: a reply never begun aloud gets its own box, all of it marked not spoken');
})().catch((e) => { console.error(e); process.exitCode = 1; });
