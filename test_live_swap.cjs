// Real-browser check of the live screen update (world/reload.js): Chromium headless opens the shipped call page, the
// server announces a new revision (one authored change, the same modules), and the update must apply on the first
// fetch: no "Keeping the call alive" retry, the change in the DOM, one world canvas. 2026-11-07: every update threw
// "Illegal invocation" (world.js read window.devicePixelRatio off a staged Object.create(window)) and retried every
// few seconds for the whole call; the node test's stub window could not show it.
// node test_live_swap.cjs   (needs /usr/bin/chromium and puppeteer-core from the npx cache)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

const pptrDir = fs.readdirSync(path.join(os.homedir(), '.npm/_npx'))
  .map((d) => path.join(os.homedir(), '.npm/_npx', d, 'node_modules/puppeteer-core'))
  .filter((d) => fs.existsSync(d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
assert.ok(pptrDir, 'puppeteer-core not in ~/.npm/_npx');
const puppeteer = require(pptrDir);

const here = __dirname;
const py = spawnSync('python3', ['-I', '-c', 'import json, sys; sys.path.insert(0, sys.argv[1]); import live_ui; print(json.dumps(live_ui.snapshot()))', here], {encoding: 'utf8'});
assert.equal(py.status, 0, py.stderr);
const now = JSON.parse(py.stdout);
const next = {...now, revision: 'f'.repeat(64), html: now.html.replace('aria-label="Conversation"', 'aria-label="Conversation, updated"')};
assert.notEqual(next.html, now.html, 'the test change applies to call.html');

let uiFetches = 0;
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
  if (u === '/call') {
    res.writeHead(200, {'content-type': 'text/html'});
    return res.end(now.html.replace('</head>', `<meta name="sheprd-ui" content="${now.revision}"></head>`, 1));
  }
  if (u === '/api/ui') { uiFetches++; return json(next); }
  if (u === '/api/ui-version') return json({type: 'ui-update', revision: uiFetches ? next.revision : now.revision});
  if (u === '/api/herd') return json({herd: []});
  if (u === '/api/show') return json({});
  if (u.startsWith('/sheprd/phaser-')) return fs.createReadStream(path.join(here, 'vendor', path.basename(u))).pipe(res);
  const name = u.slice('/sheprd/'.length);
  if (u.startsWith('/sheprd/') && typeof now.assets[name] === 'string') {
    res.writeHead(200, {'content-type': 'text/javascript'}); return res.end(now.assets[name]);
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await puppeteer.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox']});
  const retries = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({width: 412, height: 915});
    page.on('console', (m) => { if (m.text().startsWith('Keeping the call alive')) retries.push(m.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/call?plain`, {waitUntil: 'networkidle0'});
    await page.waitForFunction(() => document.querySelectorAll('#world canvas').length === 1, {timeout: 15000});
    await page.evaluate((revision) => SheprdLive.notify({type: 'ui-update', revision}), next.revision);
    await new Promise((r) => setTimeout(r, 7000));  // two of the page's 3 s retries, had it failed
    const label = await page.evaluate(() => document.getElementById('thread').getAttribute('aria-label'));
    const canvases = await page.evaluate(() => document.querySelectorAll('#world canvas').length);
    assert.deepEqual(retries, [], 'the update applies without a retry');
    assert.equal(label, 'Conversation, updated', 'the authored change is on the page');
    assert.equal(uiFetches, 1, 'one fetch of the update, no retry loop');
    assert.equal(canvases, 1, 'the new world replaced the old one');
    console.log(`PASS: live update applied on fetch 1, no retries, the change shown, ${canvases} world canvas`);
  } finally {
    await browser.close(); server.close();
  }
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
