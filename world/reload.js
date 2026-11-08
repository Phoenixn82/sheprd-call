// Patch authored DOM changes against the previous template, leaving live state and call objects alone.
(function (root) {
  'use strict';
  let before = document.documentElement.cloneNode(true), refs = new WeakMap();
  function remember(source, live, map) {
    map.set(source, live);
    [...source.childNodes].forEach((child, i) => remember(child, live.childNodes[i], map));
  }
  remember(before, document.documentElement, refs);
  let revision = document.querySelector('meta[name="sheprd-ui"]')?.content || '';
  // failed/failures: the revision that keeps failing and its try count, so retries back off and then stop.
  let assets = null, wanted = '', running = false, retry = 0, failed = '', failures = 0, applied = () => {};
  const TRIES = 5;
  const children = (node) => [...(node?.childNodes || [])].filter(n => n.nodeName !== 'SCRIPT');

  function patch(next) {
    const nextRefs = new WeakMap(), oldIds = new Map([...before.querySelectorAll('[id]')].map(n => [n.id, n]));
    function sync(old, fresh, live) {
      nextRefs.set(fresh, live);
      if (fresh.id === 'voice') return; // Never move, replace, reset or pause the remote audio element.
      if (fresh.nodeType !== 1) {
        if (!old || old.nodeValue !== fresh.nodeValue) live.nodeValue = fresh.nodeValue;
        return;
      }
      const names = new Set([...(old?.getAttributeNames() || []), ...fresh.getAttributeNames()]);
      for (const name of names) {
        const was = old?.getAttribute(name) ?? null, value = fresh.getAttribute(name);
        if (was === value) continue;
        if (name === 'class') { // Keep classes added by the call (live, muted, busy, open panels).
          const a = (was || '').split(/\s+/).filter(Boolean), b = (value || '').split(/\s+/).filter(Boolean);
          a.filter(c => !b.includes(c)).forEach(c => live.classList.remove(c));
          b.filter(c => !a.includes(c)).forEach(c => live.classList.add(c));
        } else if (value === null) live.removeAttribute(name);
        else live.setAttribute(name, value);
      }
      const previous = children(old), incoming = children(fresh), used = new Set(), pairs = [];
      for (const child of incoming) {
        const match = child.id ? oldIds.get(child.id) : previous.find(n => !n.id && !used.has(n) && n.nodeName === child.nodeName);
        if (match) used.add(match);
        const original = match && (match.id ? document.getElementById(match.id) || refs.get(match) : refs.get(match));
        const target = original && (match.id || original.parentNode === live) ? original
          : !child.id && match && live.childNodes[previous.indexOf(match)]?.nodeName === child.nodeName
            ? live.childNodes[previous.indexOf(match)] : child.cloneNode(false);
        sync(match, child, target);
        pairs.push([child, target]);
      }
      // Only authored removals touch the live DOM; generated dialogue, uploads, canvases and picker entries survive.
      for (const child of previous) if (!used.has(child)) {
        const target = child.id ? document.getElementById(child.id) || refs.get(child) : refs.get(child);
        if (target?.parentNode === live && child.id !== 'voice' && !child.querySelector?.('#voice')) target.remove();
      }
      if (previous.length !== incoming.length || incoming.some((child, i) => refs.get(previous[i]) !== nextRefs.get(child))) {
        const authored = new Set(pairs.map(([, target]) => target));
        function nextAuthored(target) {
          let next = target.nextSibling;
          while (next && !authored.has(next)) next = next.nextSibling;
          return next;
        }
        let anchor = null;
        for (const [child, target] of pairs.reverse()) {
          if (child.id !== 'voice' && !target.querySelector?.('#voice') && (target.parentNode !== live || nextAuthored(target) !== anchor)) live.insertBefore(target, anchor);
          anchor = target;
        }
      }
    }
    sync(before, next.documentElement, document.documentElement);
    before = next.documentElement;
    refs = nextRefs;
  }

  function prepare(ui, next) {
    const scripts = [...next.querySelectorAll('script[src]')].map(s => s.getAttribute('src'))
      .filter(src => /^\/sheprd\/[a-z]+\.js$/.test(src) && src !== '/sheprd/reload.js');
    const code = Object.fromEntries(scripts.map(src => {
      const name = src.slice('/sheprd/'.length);
      if (typeof ui.assets[name] !== 'string') throw new Error('Missing UI module: ' + name);
      return [name, ui.assets[name]];
    }));
    for (const [name, source] of Object.entries(ui.assets)) if (/^games\/[a-z]+\.js$/.test(name)) code[name] = source;
    if (assets && JSON.stringify(code) === JSON.stringify(assets)) return null;
    // The modules' own globals land on the stage; everything else reads through to the real window, with the window
    // as receiver: its getters and methods (devicePixelRatio, timers) throw "Illegal invocation" on any other object.
    // 2026-11-07: Object.create(window) made world.js's window.devicePixelRatio throw, so every update failed and
    // retried forever, and he hung up and reopened Sheprd to see a fix.
    const stage = new Proxy({SHEPRD: {}, SheprdWorld: undefined, SheprdGames: undefined}, {
      get(own, key) {
        if (key in own) return own[key];
        const value = root[key];
        return typeof value === 'function' ? value.bind(root) : value;
      },
      has: (own, key) => key in own || key in root,
    });
    for (const [name, source] of Object.entries(code)) {
      // Art functions retain the real document; the staged registry must not start parallel script downloads.
      new Function('window', 'globalThis', 'document', 'Phaser', 'SheprdGames', source)(
        stage, stage, name === 'games.js' ? undefined : document, root.Phaser, stage.SheprdGames);
    }
    if (!stage.SheprdWorld?.mount || !stage.SheprdGames || stage.SheprdGames.list().length !== stage.SheprdGames.REGISTRY.length)
      throw new Error('Incomplete UI modules');
    return {stage, code};
  }

  async function drain() {
    if (running) return;
    running = true;
    clearTimeout(retry);
    try {
      while (wanted && wanted !== revision) {
        const requested = wanted, controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6500);
        let response;
        try { response = await fetch('api/ui', {cache: 'no-store', headers: {'X-Sheprd': '1'}, signal: controller.signal}); }
        finally { clearTimeout(timeout); }
        if (!response.ok) throw new Error('Screen update answered ' + response.status);
        const ui = await response.json();
        if (!/^[a-f0-9]{64}$/.test(ui.revision) || typeof ui.html !== 'string' || !ui.assets) throw new Error('Invalid screen update');
        const next = new DOMParser().parseFromString(ui.html, 'text/html');
        const voice = next.getElementById('voice'), oldVoice = before.querySelector('#voice');
        if (!voice || voice.nodeName !== 'AUDIO' || voice.parentNode.id !== oldVoice.parentNode.id || voice.parentNode.nodeName !== oldVoice.parentNode.nodeName)
          throw new Error('Screen update must retain the voice element and its parent');
        const ids = new Set();
        for (const node of next.querySelectorAll('[id]')) {
          const old = before.querySelector('[id="' + node.id + '"]');
          if (ids.has(node.id) || old && old.nodeName !== node.nodeName) throw new Error('Screen update must retain element IDs and their tags');
          ids.add(node.id);
        }
        const modules = prepare(ui, next);
        // Only same-origin authored CSS participates; scripts in call.html never rerun during a call.
        for (const link of next.querySelectorAll('link[rel="stylesheet"]')) {
          const url = new URL(link.getAttribute('href'), location.href);
          if (url.origin !== location.origin || !/^\/sheprd\/[a-z]+\.css$/.test(url.pathname)) throw new Error('Unsupported screen stylesheet');
          url.searchParams.set('ui', ui.revision); link.setAttribute('href', url.href);
        }
        if (modules) applied(modules.stage);
        patch(next);
        if (modules) assets = modules.code;
        revision = ui.revision;
        if (wanted === requested || wanted === ui.revision) wanted = '';
      }
      failed = ''; failures = 0;
    } catch (error) {
      // 2026-11-08: a broken update retried every 3 s for the whole call; now 3, 6, 12, 24 s, then it waits for a newer one.
      if (failed !== wanted) { failed = wanted; failures = 0; }
      if (++failures < TRIES) {
        const delay = 3000 * 2 ** (failures - 1);
        console.warn('Keeping the call alive; screen update will retry in ' + delay / 1000 + ' s:', error);
        retry = setTimeout(drain, delay);
      } else console.warn('Keeping the call alive; screen update stopped after ' + TRIES + ' tries until a newer one arrives:', error);
    } finally { running = false; }
  }
  root.SheprdLive = {
    start(onApplied) { applied = onApplied; },
    notify(message) {
      // A repeat of the failing revision (the off-call poll sends one every 3 s) leaves the back-off timer in charge.
      if (!message || !/^[a-f0-9]{64}$/.test(message.revision) || message.revision === revision || message.revision === failed) return;
      wanted = message.revision;
      drain();
    },
  };
})(window);
