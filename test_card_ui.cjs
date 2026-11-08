// Node-only check of the card kinds (call.html CARDS, shown.py KINDS): an image marker shows the picture, an audio
// marker shows a Play key whose clip plays inside the page; while it plays on a call the mic is held and the desk's
// voice turned down, both back on pause or end; a new card or Dismiss stops it; a name the route would refuse is text.
const assert = require('node:assert/strict');
const H = require('./ui_harness.cjs');
const {document} = H;

(async () => {
  const context = H.load('');
  const card = document.getElementById('card'), image = document.getElementById('cardimage'), audio = document.getElementById('cardaudio');
  const clip = document.getElementById('clip'), play = document.getElementById('play'), text = document.getElementById('cardtext');
  const voice = document.getElementById('voice');
  const tracks = [{enabled: true}, {enabled: true}];
  context.probe.pc = {connectionState: 'connected'}; context.probe.mic = {getAudioTracks: () => tracks, getTracks: () => tracks};

  context.showCard({type: 'show', text: 'image:shot.png', id: 'a'});
  assert.equal(card.hidden, false); assert.equal(image.hidden, false); assert.equal(audio.hidden, true); assert.equal(text.hidden, true);
  assert.equal(document.getElementById('shownimage').src, 'api/shown/shot.png');

  context.showCard({type: 'show', text: 'audio:' + 'c'.repeat(32) + '.mp3', id: 'b'});
  assert.equal(image.hidden, true); assert.equal(audio.hidden, false); assert.equal(text.hidden, true);
  assert.equal(clip.getAttribute('src'), 'api/shown/' + 'c'.repeat(32) + '.mp3');
  assert.equal(play.textContent, 'Play');
  play.click(); await H.settle();
  assert.equal(clip.paused, false); assert.equal(play.textContent, 'Pause');
  assert.deepEqual(tracks.map((t) => t.enabled), [false, false], 'the mic is held while the clip plays');
  assert.equal(voice.volume, 0.2, 'the desk\'s voice is turned down');
  play.click();
  assert.equal(clip.paused, true); assert.equal(play.textContent, 'Play');
  assert.deepEqual(tracks.map((t) => t.enabled), [true, true]); assert.equal(voice.volume, 1);
  play.click(); clip.ended = true; clip.paused = true; clip.events.ended();  // a browser pauses at the end
  assert.equal(play.textContent, 'Play again'); assert.deepEqual(tracks.map((t) => t.enabled), [true, true]);
  clip.ended = false; play.click(); assert.equal(clip.paused, false);
  document.getElementById('dismiss').click();
  assert.equal(card.hidden, true); assert.equal(clip.paused, true); assert.equal(clip.getAttribute('src'), null);
  assert.deepEqual(tracks.map((t) => t.enabled), [true, true]);
  // a clip playing when the next card lands stops; a muted mic stays muted through a clip
  context.showCard({type: 'show', text: 'audio:again.ogg', id: 'c'}); play.click(); assert.equal(clip.paused, false);
  context.showCard({type: 'show', text: 'audio:other.wav', id: 'd'}); assert.equal(clip.paused, true); assert.equal(clip.getAttribute('src'), 'api/shown/other.wav');
  context.setMuted(true); tracks.forEach((t) => { t.enabled = false; });
  play.click(); play.click(); assert.deepEqual(tracks.map((t) => t.enabled), [false, false]);
  context.setMuted(false);
  // names the route refuses are plain text cards, never a Play key or a request
  for (const bad of ['audio:x.flac', 'audio:../x.mp3', 'audio:a b.mp3', 'audio:' + 'x'.repeat(130) + '.mp3', 'image:x.mp3', 'video:x.mp4']) {
    context.showCard({type: 'show', text: bad, id: bad});
    assert.equal(audio.hidden, true, bad); assert.equal(image.hidden, true, bad); assert.equal(text.hidden, false, bad); assert.equal(text.textContent, bad);
  }
  console.log('PASS: image and audio cards; the clip plays in the page, holds the mic and ducks the voice; stops on a new card or Dismiss; bad names stay text');
})().catch((error) => { console.error(error); process.exitCode = 1; });
