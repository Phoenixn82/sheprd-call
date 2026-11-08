// Sheprd waiting games: the registry. One line per game here, one file per game in games/<id>.js (served as
// /sheprd/games/<id>.js); the call page loads this file, this file loads the modules, and the game picker reads
// list(). Adding a game is: write games/<id>.js (see README "Adding a waiting game"), add its id to REGISTRY, done.
//
// A module calls SheprdGames.add({ id, name, verb, hint, start, tap, step, draw[, release] }):
//   id       the file name without .js; name: the picker's label; verb: the key under the world ("Jump", "Flap");
//   hint     one line shown under the board while it runs;
//   start(G) a new run: put the run's state on G.s and set G.score = 0;
//   tap(G)   the one button, pressed; release(G) optional, the button let go (hold games);
//   step(G, dt) advance by dt (1 = one 60 fps frame); return true when the run is over;
//   draw(G)  paint the frame. G: w, h (css px), px (the pixel unit, 4), g (the 2d context, ink already the fill style),
//            ink, paper, rnd(), rect(x, y, w, h) snapped to the pixel grid, text(str, x, y, align), rows(lines, x, y)
//            (block characters as pixels), score. The page draws the score and the best over the board.
(function (root) {
  'use strict';
  const REGISTRY = ['run', 'flap', 'catch', 'dodge', 'stack', 'wall', 'lock', 'shear', 'orbit', 'bridge', 'balloon'];
  const HOOKS = ['start', 'tap', 'step', 'draw'];
  const have = new Map();
  const api = root.SheprdGames = {
    REGISTRY, HOOKS,
    add(game) {
      if (!game || typeof game.id !== 'string' || !REGISTRY.includes(game.id)) throw new Error('game id not in the registry: ' + (game && game.id));
      for (const h of HOOKS) if (typeof game[h] !== 'function') throw new Error(game.id + ' lacks ' + h + '()');
      for (const s of ['name', 'verb', 'hint']) if (typeof game[s] !== 'string' || !game[s]) throw new Error(game.id + ' lacks ' + s);
      have.set(game.id, game);
      return game;
    },
    list() { return REGISTRY.filter(id => have.has(id)).map(id => have.get(id)); },  // registry order, loaded ones
    get(id) { return have.get(id) || null; },
    whenLoaded(fn) { if (pending <= 0) fn(); else waiting.push(fn); },  // every registered file has loaded (or failed)
  };
  let pending = 0; const waiting = [];
  const settled = () => { if (--pending <= 0) waiting.splice(0).forEach(fn => fn()); };
  // In a page: load every registered module (a missing or broken file leaves that game out of the picker).
  if (typeof document !== 'undefined' && document.head && typeof document.createElement === 'function') {
    const base = (document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/games\.js(\?.*)?$/, '') : '/sheprd/';
    pending = REGISTRY.length;
    for (const id of REGISTRY) { const s = document.createElement('script'); s.src = base + 'games/' + id + '.js'; s.async = false; s.onload = s.onerror = settled; document.head.append(s); }
  }
})(typeof window !== 'undefined' ? window : globalThis);
