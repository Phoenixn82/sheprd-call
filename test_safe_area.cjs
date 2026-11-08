// Real-browser check of the safe area (2026-11-07: "the stuff at the top of the app if hiding behind the phones
// widgits and battery and time"). the phone app draws edge to edge, so the WebView reports the status bar, gesture bar and
// cutouts as env(safe-area-inset-*). Chromium headless, with those insets emulated over CDP, renders ?demo&call
// portrait (a phone: 412x915, 48 px status bar, 24 px gesture bar) and landscape (48 px cutout on the left), and
// every visible box of the HUD, thread, type box and Send must sit inside the safe rect.
// node test_safe_area.cjs [shot-dir]   (needs /usr/bin/chromium and puppeteer-core from the npx cache)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const pptrDir = fs.readdirSync(path.join(os.homedir(), '.npm/_npx'))
  .map((d) => path.join(os.homedir(), '.npm/_npx', d, 'node_modules/puppeteer-core'))
  .filter((d) => fs.existsSync(d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
assert.ok(pptrDir, 'puppeteer-core not in ~/.npm/_npx');
const puppeteer = require(pptrDir);

const here = __dirname, shots = process.argv[2];
const file = (url) => {  // the routes bot.py serves the page and its world files on
  const u = url.split('?')[0];
  if (u === '/' ) return path.join(here, 'call.html');
  if (u.startsWith('/sheprd/phaser-')) return path.join(here, 'vendor', path.basename(u));
  if (u.startsWith('/sheprd/games/')) return path.join(here, 'world/games', path.basename(u));
  if (u.startsWith('/sheprd/')) return path.join(here, 'world', path.basename(u));
  return null;
};
const server = http.createServer((req, res) => {
  const f = file(req.url);
  if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'content-type': f.endsWith('.html') ? 'text/html' : 'text/javascript'});
  fs.createReadStream(f).pipe(res);
});

// The grip on the thread's top edge resizes it (drag and keys, 15-75% of the screen); the thread keeps the newest line
// in view through new lines and resizes while he is at the bottom, and holds still once he scrolls up.
async function gripAndFollow(page) {
  const H = () => page.evaluate(() => ({h: document.getElementById('thread').getBoundingClientRect().height,
    now: +document.getElementById('grip').getAttribute('aria-valuenow')}));
  const gap = () => page.evaluate(() => { const b = document.getElementById('thread'); return b.scrollHeight - b.scrollTop - b.clientHeight; });
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const a = await H();
  const g = await (await page.$('#grip')).boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 150, {steps: 6}); await page.mouse.up();
  const b = await H();
  assert.ok(b.h > a.h + 100 && b.now > a.now, `drag up grows the thread: ${JSON.stringify([a, b])}`);
  await page.focus('#grip'); await page.keyboard.press('Home');
  assert.equal((await H()).now, 15, 'Home: the smallest thread');
  await page.keyboard.press('ArrowUp');
  assert.equal((await H()).now, 20, 'ArrowUp: 5 more');
  await page.keyboard.press('End');
  const big = await H();
  assert.equal(big.now, 75, 'End: the largest thread');
  // following
  await page.evaluate(() => { for (let i = 0; i < 30; i++) thread.add(i % 2 ? 'you' : 'desk', i % 2 ? 'You' : 'SHEPRD', 'Line ' + i + ' of a long talk.'); });
  await frames();
  assert.ok(await gap() < 8, 'new lines keep the newest in view');
  await page.keyboard.press('Home'); await frames();
  assert.ok(await gap() < 8, 'shrinking the thread keeps the newest in view');
  await page.keyboard.press('End'); await frames();
  assert.ok(await gap() < 8, 'growing the thread keeps the newest in view');
  await page.evaluate(() => { document.getElementById('thread').scrollTop -= 300; }); await frames();
  const before = await page.evaluate(() => document.getElementById('thread').scrollTop);
  await page.evaluate(() => { thread.add('desk', 'SHEPRD', 'A new line while he reads back, long enough to wrap onto a second line.'); }); await frames();
  const after = await page.evaluate(() => ({top: document.getElementById('thread').scrollTop, newer: !document.getElementById('newer').hidden}));
  assert.ok(Math.abs(after.top - before) < 2 && after.newer, `scrolled up: he stays put and Newest waits ${JSON.stringify([before, after])}`);
  await page.click('#newer'); await frames();
  assert.ok(await gap() < 8, 'Newest goes back to the bottom');
  console.log(`PASS: grip drag ${a.now}%->${b.now}%, keys Home 15 / ArrowUp 20 / End 75; follows new lines and resizes, holds while scrolled up`);
}

// One thinking indicator: the pondering portrait in a waiting box after his turn (no HUD dots, no "..." in the world);
// dragged closed, the thread goes and the portrait sits top left inside the safe area, pondering there.
async function thinkingAndClosed(page, c) {
  await page.evaluate(() => { thread.add('you', 'You', 'What is the api tab doing?'); thinking(true); });
  await new Promise((r) => setTimeout(r, 300));
  const open = await page.evaluate(() => {
    const li = document.getElementById('lines').lastElementChild, face = li.querySelector('.face');
    return {waiting: li.classList.contains('waiting'), face: face.getAttribute('data-face'), anim: getComputedStyle(face).animationName,
      dots: !!document.getElementById('think'), live: document.getElementById('thinklive').textContent};
  });
  assert.deepEqual(open, {waiting: true, face: 'shepherd-thinking', anim: 'ponder', dots: false, live: 'Thinking.'});
  if (shots) await page.screenshot({path: path.join(shots, 'sheprd-thinking-in-thread.png')});
  const g = await (await page.$('#grip')).boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, c.h - 10, {steps: 8}); await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  const closed = await page.evaluate(() => {
    while (bubble.running) bubble.done(); sprite.level(0); thinking(true);  // the demo talks on a fake voice level: quiet it so the mood is thinking
    const k = document.getElementById('corner'), r = k.getBoundingClientRect();
    return {off: document.getElementById('screen').classList.contains('chatoff'), thread: getComputedStyle(document.getElementById('thread')).display,
      face: k.getAttribute('data-face'), anim: getComputedStyle(k).animationName, top: r.top, left: r.left, w: r.width,
      now: document.getElementById('grip').getAttribute('aria-valuenow'), grip: document.getElementById('grip').getBoundingClientRect().bottom};
  });
  assert.deepEqual([closed.off, closed.thread, closed.face, closed.anim, closed.now], [true, 'none', 'shepherd-thinking', 'ponder', '0'], JSON.stringify(closed));
  assert.ok(closed.top >= c.insets.top && closed.left >= c.insets.left && closed.w > 40, `corner portrait inside the safe area ${JSON.stringify(closed)}`);
  assert.ok(closed.grip <= c.h - c.insets.bottom, 'the grip stays on screen to open the chat again');
  if (shots) await page.screenshot({path: path.join(shots, 'sheprd-chat-closed.png')});
  await page.evaluate(() => thinking(false));
  await page.focus('#grip'); await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.getElementById('screen').classList.contains('chatoff')), false, 'Arrow Up opens it');
  console.log(`PASS: thinking is the portrait in the waiting box (no dots); dragged closed, it ponders top left at ${closed.left},${closed.top}`);
}

const CASES = [
  {name: 'portrait', w: 412, h: 915, insets: {top: 48, bottom: 24, left: 0, right: 0}},
  {name: 'landscape', w: 915, h: 412, insets: {top: 0, bottom: 24, left: 48, right: 0}},
];

// Actual touch events and a playing MediaStream in the same phone viewport/insets as the shipping screen.
async function tapReveal(page, base) {
  await page.goto(base + '?demo&call&pose=idle', {waitUntil: 'load'});
  await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone') ?? true);
  await page.touchscreen.tap(200, 100);  // user activation for audio playback
  const text = 'Tapping my portrait shows the whole reply immediately while I keep speaking. You can read ahead at your own pace, and the next reply will still appear normally.';
  await page.evaluate(async (text) => {
    while (bubble.running) bubble.done();
    const ctx = new AudioContext(), tone = ctx.createOscillator(), out = ctx.createMediaStreamDestination();
    tone.connect(out); tone.start(); await ctx.resume();
    const voice = document.getElementById('voice'); voice.srcObject = out.stream; await voice.play();
    window.revealAudio = {ctx, tone, stream: out.stream, peer: {connectionState: 'connected', close() { throw new Error('tap closed the call'); }}};
    pc = revealAudio.peer;
    thread.add('you', 'You', 'Can I read ahead while you speak?');
    appMessage({data: JSON.stringify({type: 'say', text})});
  }, text);
  const words = () => page.$eval('#lines li:last-child .words', (el) => el.textContent);
  assert.notEqual(await words(), text, 'untapped reply is still paced');
  if (shots) await page.screenshot({path: path.join(shots, 'sheprd-reveal-before.png')});
  const before = await page.$eval('#voice', (v) => v.currentTime);
  const touch = async (selector) => {
    const r = await (await page.$(selector)).boundingBox();
    assert.ok(r && r.width && r.height, selector + ' visible');
    await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  };
  await touch('#lines li:last-child .face');
  assert.equal(await words(), text, 'touching the portrait reveals every word');
  if (shots) await page.screenshot({path: path.join(shots, 'sheprd-reveal-portrait.png')});
  await page.evaluate(() => appMessage({data: JSON.stringify({type: 'say', text: 'Later sentences appear immediately too.'})}));
  assert.equal(await words(), text + ' Later sentences appear immediately too.');
  await page.evaluate((text) => {
    thread.add('you', 'You', 'And the reply bubble?');
    appMessage({data: JSON.stringify({type: 'say', text})});
  }, text);
  assert.notEqual(await words(), text, 'the next reply resets to paced');
  await touch('#lines li:last-child .words');
  assert.equal(await words(), text, 'touching the reply bubble reveals every word');
  await new Promise((r) => setTimeout(r, 300));
  const playing = await page.evaluate(() => {
    const v = document.getElementById('voice');
    return {paused: v.paused, time: v.currentTime, sameStream: v.srcObject === revealAudio.stream,
      track: v.srcObject.getAudioTracks()[0].readyState, samePeer: pc === revealAudio.peer};
  });
  assert.ok(!playing.paused && playing.time > before && playing.sameStream && playing.track === 'live' && playing.samePeer, JSON.stringify(playing));
  if (shots) await page.screenshot({path: path.join(shots, 'sheprd-reveal-bubble.png')});
  await page.evaluate((text) => {
    thread.add('you', 'You', 'And with chat hidden?');
    appMessage({data: JSON.stringify({type: 'say', text})}); grip.set(0);
  }, text);
  await touch('#corner');
  assert.equal(await words(), text);
  assert.equal(await page.$eval('#screen', (el) => el.classList.contains('chatoff')), false);
  if (shots) await page.screenshot({path: path.join(shots, 'sheprd-reveal-corner.png')});
  await page.evaluate(() => { revealAudio.tone.stop(); revealAudio.ctx.close(); pc = null; });
  console.log('PASS: real phone-inset touch on portrait, bubble and closed-chat corner reveals full reply; next reply paced; playing audio clock advances on the same live stream and connection');
}

// He cut in (2026-11-07): the reply's box keeps the words he heard, then the rest dimmed behind a NOT SPOKEN tag, all
// inside the safe area; his line follows. And with a panel open on a call and the chat closed, only the 32-bit portrait
// shows top left: the world draws no 8-bit head corner beside it (the owner: "Yes" to removing it).
async function cutOffAndNoHead(page, base, c) {
  await page.goto(base + '?demo&call&pose=idle', {waitUntil: 'load'});
  await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone') ?? true);
  await page.evaluate(() => {
    while (bubble.running) bubble.done();
    thread.add('you', 'You', 'What is left on the api tab?');
    const m = (type, props) => appMessage({data: JSON.stringify({type, ...props})});
    m('say', {text: 'The api tab finished the parser fix and the tests pass. Next it needs a review of the retry logic before'});
    m('say-stop', {heard: 'The api tab finished the parser fix and the tests pass. Next it needs'});
    m('unspoken', {text: 'a review of the retry logic before it ships. I would also bump the timeout to thirty seconds, since the staging box is slow.'});
    m('heard', {text: 'Hold on, which tab?'});
  });
  await new Promise((r) => setTimeout(r, 300));
  const got = await page.evaluate(() => {
    const li = [...document.querySelectorAll('#lines li')].find((x) => x.querySelector('.unspoken'));
    const rest = li.querySelector('.unspoken'), tag = rest.querySelector('.tag'), box = (el) => { const r = el.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height}; };
    return {heard: li.querySelector('.words').textContent, tag: tag.textContent, tagText: getComputedStyle(tag).textTransform, rest: rest.lastChild.textContent,
      color: getComputedStyle(rest).color, ink: getComputedStyle(li.querySelector('.words')).color, restBox: box(rest), tagBox: box(tag),
      last: document.querySelector('#lines li:last-child').classList.contains('you')};
  });
  assert.equal(got.heard, 'The api tab finished the parser fix and the tests pass. Next it needs');
  assert.deepEqual([got.tag, got.tagText, got.last], ['not spoken', 'uppercase', true]);
  assert.match(got.rest, /^a review of the retry logic/);
  assert.notEqual(got.color, got.ink, 'the not-spoken words are dimmed');
  for (const b of [got.restBox, got.tagBox]) assert.ok(b.h > 8 && b.top >= c.insets.top && b.bottom <= c.h - c.insets.bottom && b.left >= 0 && b.right <= c.w, JSON.stringify(b));
  if (shots) await page.screenshot({path: path.join(shots, 'sheprd-cut-not-spoken.png')});
  console.log(`PASS: cut-off reply at ${c.w}x${c.h}: heard words in ink, the rest dimmed (${got.color}) after a NOT SPOKEN tag, inside the safe area`);

  await page.goto(base + '?demo&call&pose=talking&card', {waitUntil: 'load'});
  await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone') ?? true);
  await page.evaluate(() => grip.set(0));
  await new Promise((r) => setTimeout(r, 800));
  const head = await page.evaluate(() => ({corner: getComputedStyle(document.getElementById('corner')).display, card: !document.getElementById('card').hidden,
    worldHead: !!(world && world.scene && world.scene.head), compact: document.getElementById('screen').classList.contains('compact'),
    hudLeft: document.getElementById('hud').getBoundingClientRect().left,
    clear: document.getElementById('card').getBoundingClientRect().top >= document.getElementById('corner').getBoundingClientRect().bottom}));
  assert.deepEqual(head, {corner: 'block', card: true, worldHead: false, compact: false, hudLeft: 6, clear: true}, JSON.stringify(head));
  if (shots) await page.screenshot({path: path.join(shots, 'sheprd-portrait-only.png')});
  console.log('PASS: panel open on a call, chat closed: the 32-bit portrait alone top left, no 8-bit head corner');
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await puppeteer.launch({executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  try {
    for (const c of CASES) {
      const page = await browser.newPage();
      await page.setViewport({width: c.w, height: c.h, deviceScaleFactor: 1, isMobile: true, hasTouch: true});
      const cdp = await page.createCDPSession();
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {insets: c.insets});
      await page.goto(base + '?demo&call', {waitUntil: 'load'});
      await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone') ?? true, {timeout: 15000}).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      // The emulation took (else every box passes for the wrong reason).
      const pad = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('main')); return [s.paddingTop, s.paddingBottom, s.paddingLeft]; });
      assert.deepEqual(pad, [c.insets.top + 'px', c.insets.bottom + 'px', c.insets.left + 'px'], `${c.name}: env() insets not applied to main`);
      const boxes = await page.evaluate(() => {
        const out = [];
        for (const sel of ['#hud', '#hud *', '#grip', '#thread', '#controls', '#typed', '#controls button']) {
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            if (r.width < 2 || r.height < 2 || s.visibility === 'hidden' || s.display === 'none') continue;
            out.push({sel: sel + (el.id ? '#' + el.id : ''), top: r.top, bottom: r.bottom, left: r.left, right: r.right});
          }
        }
        return out;
      });
      assert.ok(boxes.some((b) => b.sel.startsWith('#hud')), `${c.name}: no HUD box rendered`);
      assert.ok(boxes.some((b) => b.sel.includes('typed')), `${c.name}: no type box rendered`);
      const safe = {top: c.insets.top, bottom: c.h - c.insets.bottom, left: c.insets.left, right: c.w - c.insets.right};
      const out = boxes.filter((b) => b.top < safe.top - 0.5 || b.bottom > safe.bottom + 0.5 || b.left < safe.left - 0.5 || b.right > safe.right + 0.5);
      assert.deepEqual(out, [], `${c.name}: boxes outside the safe area`);
      if (shots) await page.screenshot({path: path.join(shots, `sheprd-safe-area-${c.name}.png`)});
      console.log(`PASS: ${c.name} ${c.w}x${c.h} insets ${JSON.stringify(c.insets)}: ${boxes.length} boxes inside the safe area`);
      if (c.name === 'portrait') { await gripAndFollow(page); await thinkingAndClosed(page, c); await tapReveal(page, base); await cutOffAndNoHead(page, base, c); }
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
