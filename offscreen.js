// Runs Stockfish in a Web Worker and streams results back through the background worker.
(function () {
  const ENGINES = {
    'sf18-nnue': {
      file: 'stockfish-18-lite.js',
      name: 'Stockfish 18 NNUE',
      shortName: 'SF 18 NNUE',
      threaded: true,
      defaultHash: 128,
      loadTimeout: 30000,
      fallback: 'lite-mt'
    },
    'lite-mt': {
      file: 'stockfish-19-lite.js',
      name: 'Stockfish 19 Lite MT',
      shortName: 'SF 19 Lite',
      threaded: true,
      defaultHash: 64,
      loadTimeout: 20000,
      fallback: 'lite'
    },
    lite: {
      file: 'stockfish-19-lite-single.js',
      name: 'Stockfish 19 Lite',
      shortName: 'SF 19 Lite',
      threaded: false,
      defaultHash: 64,
      loadTimeout: 20000,
      fallback: null
    }
  };

  function canUseThreads() {
    return typeof SharedArrayBuffer !== 'undefined' && !!globalThis.crossOriginIsolated;
  }

  function resolveEngineKey(requested, hasCOI) {
    let key = ENGINES[requested] ? requested : 'sf18-nnue';
    if (ENGINES[key].threaded && !hasCOI) key = 'lite';
    return key;
  }

  function resolveThreads(reqThreads, engineCfg, hwConcurrency) {
    if (!engineCfg || !engineCfg.threaded) return 1;
    const n = Number(reqThreads) || 0;
    if (n > 0) return Math.max(1, Math.min(32, Math.floor(n)));
    const hw = Number(hwConcurrency) || 4;
    return Math.max(1, Math.min(16, hw >= 4 ? hw - 1 : hw));
  }

  function resolveHash(reqHash, engineCfg) {
    const h = Number(reqHash) || 0;
    if (h >= 16) return Math.max(16, Math.min(1024, Math.floor(h)));
    return engineCfg ? engineCfg.defaultHash : 128;
  }

  function parseInfoLine(l, sideToMove) {
    if (!l || !l.startsWith('info') || !l.includes(' pv ')) return null;
    const t = l.split(' ');
    let depth = 0, seldepth = 0, mpv = 1, cp = null, mate = null, pv = [], nodes = 0, nps = 0, hashfull = 0, time = 0, bound = false;
    let wdl = null;
    for (let i = 0; i < t.length; i++) {
      const k = t[i];
      if (k === 'depth') depth = +t[++i];
      else if (k === 'seldepth') seldepth = +t[++i];
      else if (k === 'multipv') mpv = +t[++i];
      else if (k === 'nodes') nodes = +t[++i];
      else if (k === 'nps') nps = +t[++i];
      else if (k === 'hashfull') hashfull = +t[++i];
      else if (k === 'time') time = +t[++i];
      else if (k === 'score') {
        const ty = t[++i], v = +t[++i];
        if (ty === 'cp') cp = v;
        else if (ty === 'mate') mate = v;
      } else if (k === 'wdl') {
        const w = +t[++i], d = +t[++i], loss = +t[++i];
        if (Number.isFinite(w) && Number.isFinite(d) && Number.isFinite(loss)) wdl = [w, d, loss];
      } else if (k === 'lowerbound' || k === 'upperbound') {
        bound = true;
      } else if (k === 'pv') {
        pv = t.slice(i + 1).filter(Boolean);
        break;
      }
    }
    if (bound || !pv.length || (cp === null && mate === null)) return null;
    if (sideToMove === 'b') {
      if (cp !== null) cp = -cp;
      if (mate !== null) mate = -mate;
      if (wdl) wdl = [wdl[2], wdl[1], wdl[0]];
    }
    return { depth, seldepth, mpv, cp, mate, wdl, pv, nodes, nps, hashfull, time };
  }

  function buildPositionCommand(req) {
    if (req && req.startFen && Array.isArray(req.moves) && req.moves.length > 0) {
      return 'position fen ' + req.startFen + ' moves ' + req.moves.join(' ');
    }
    return 'position fen ' + req.fen;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ENGINES, canUseThreads, resolveEngineKey, resolveThreads, resolveHash, parseInfoLine, buildPositionCommand };
  }
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.connect) return;

  let port = null;
  let sf = null, ready = false, loadedKey = null, engTimer = 0, engineName = '', engineShort = '';
  let searching = false, stopping = false, pending = null, cur = null;
  let appliedMpv = 1, appliedThreads = 1, appliedHash = 0, appliedChess960 = false;
  let lastTabId = null;

  function connect() {
    port = chrome.runtime.connect({ name: 'engine' });
    port.onMessage.addListener(onRequest);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 300); });
  }
  function send(m) { if (port) { try { port.postMessage(m); } catch (e) {} } }
  function note(text) {
    const t = pending || cur;
    if (t) send({ type: 'status', tabId: t.tabId, fen: t.fen, text });
  }

  function load(key) {
    clearTimeout(engTimer);
    try { sf && sf.terminate(); } catch (e) {}
    sf = null; ready = false; searching = false; stopping = false;
    appliedMpv = 1; appliedThreads = 1; appliedHash = 0; appliedChess960 = false;
    loadedKey = key;
    const E = ENGINES[key];
    note('Loading ' + E.name + '…');
    try {
      sf = new Worker(E.file);
      sf.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); fail(key); };
      sf.onmessage = (e) => onLine(String(e.data));
      try {
        sf.postMessage('setoption name CanOutputEngineDownloadProgress');
        const ch = new MessageChannel();
        ch.port1.onmessage = (ev) => {
          if (!ready && loadedKey === key && ev.data && typeof ev.data.percent === 'number') {
            const pct = Math.min(99, Math.round(ev.data.percent * 100));
            note(`Loading ${E.name} (${pct}%)…`);
          }
        };
        sf.postMessage({ progressPort: ch.port2 }, [ch.port2]);
      } catch (e) {}
      sf.postMessage('uci');
    } catch (e) { fail(key); return; }
    engTimer = setTimeout(() => { if (!ready && loadedKey === key) fail(key); }, E.loadTimeout || 30000);
  }

  function fail(key) {
    if (ready || loadedKey !== key) return;
    clearTimeout(engTimer);
    const E = ENGINES[key];
    if (E && E.fallback) {
      const fb = resolveEngineKey(E.fallback, canUseThreads());
      if (fb !== key) {
        note(`${E.name} unavailable — switching to ${ENGINES[fb].name}…`);
        load(fb);
        return;
      }
    }
    const t = pending || cur;
    send({ type: 'error', tabId: t && t.tabId, msg: 'Engine failed to load' });
  }

  function onLine(l) {
    if (l === 'uciok') {
      const E = ENGINES[loadedKey];
      const req = pending || cur || {};
      const th = resolveThreads(req.threads, E, navigator.hardwareConcurrency);
      const hash = resolveHash(req.hash, E);
      if (E.threaded) {
        sf.postMessage('setoption name Threads value ' + th);
        appliedThreads = th;
      } else {
        appliedThreads = 1;
      }
      sf.postMessage('setoption name Hash value ' + hash);
      appliedHash = hash;
      sf.postMessage('setoption name UCI_ShowWDL value true');
      sf.postMessage('setoption name Move Overhead value 0');
      sf.postMessage('isready');
      return;
    }
    if (l === 'readyok') {
      if (!ready) {
        ready = true;
        clearTimeout(engTimer);
        engineName = ENGINES[loadedKey].name;
        engineShort = ENGINES[loadedKey].shortName;
        kick();
      }
      return;
    }
    if (l.startsWith('bestmove')) {
      const wasStop = stopping;
      searching = false;
      stopping = false;
      if (!wasStop && cur) {
        send({ type: 'done', tabId: cur.tabId, fen: cur.fen, engineKey: loadedKey, engineShort, threads: appliedThreads, hash: appliedHash });
      }
      kick();
      return;
    }
    if (l.startsWith('info') && !stopping && cur) parseInfo(l);
  }

  function parseInfo(l) {
    const side = cur.fen.split(' ')[1];
    const parsed = parseInfoLine(l, side);
    if (!parsed) return;
    send({
      type: 'info',
      tabId: cur.tabId,
      fen: cur.fen,
      engine: engineName,
      engineShort,
      engineKey: loadedKey,
      threads: appliedThreads,
      hash: appliedHash,
      ...parsed
    });
  }

  function kick() {
    if (!ready || searching || !pending) return;
    cur = pending;
    pending = null;
    const E = ENGINES[loadedKey];

    if (cur.newGame || (lastTabId !== null && lastTabId !== cur.tabId)) {
      sf.postMessage('ucinewgame');
    }
    lastTabId = cur.tabId;

    const wantThreads = resolveThreads(cur.threads, E, navigator.hardwareConcurrency);
    if (E.threaded && appliedThreads !== wantThreads) {
      sf.postMessage('setoption name Threads value ' + wantThreads);
      appliedThreads = wantThreads;
    }
    const wantHash = resolveHash(cur.hash, E);
    if (appliedHash !== wantHash) {
      sf.postMessage('setoption name Hash value ' + wantHash);
      appliedHash = wantHash;
    }
    const wantMpv = Math.max(1, Math.min(8, cur.multipv || 1));
    if (appliedMpv !== wantMpv) {
      sf.postMessage('setoption name MultiPV value ' + wantMpv);
      appliedMpv = wantMpv;
    }
    const want960 = !!cur.chess960;
    if (appliedChess960 !== want960) {
      sf.postMessage('setoption name UCI_Chess960 value ' + (want960 ? 'true' : 'false'));
      appliedChess960 = want960;
    }

    sf.postMessage(buildPositionCommand(cur));
    sf.postMessage(cur.depth >= 99 ? 'go infinite' : 'go depth ' + cur.depth);
    searching = true;
    send({
      type: 'started',
      tabId: cur.tabId,
      fen: cur.fen,
      engine: engineName,
      engineShort,
      engineKey: loadedKey,
      threads: appliedThreads,
      hash: appliedHash
    });
  }

  function onRequest(m) {
    if (m.type === 'go') {
      pending = {
        tabId: m.tabId,
        fen: m.fen,
        startFen: m.startFen || null,
        moves: Array.isArray(m.moves) ? m.moves : null,
        newGame: !!m.newGame,
        chess960: !!m.chess960,
        multipv: m.multipv || 1,
        depth: m.depth || 20,
        threads: m.threads || 0,
        hash: m.hash || 0
      };
      const target = resolveEngineKey(m.engine || 'sf18-nnue', canUseThreads());
      if (loadedKey !== target) {
        load(target);
        return;
      }
      if (!ready) {
        note('Loading ' + ENGINES[loadedKey].name + '…');
        return;
      }
      if (searching) {
        if (!stopping) {
          stopping = true;
          sf.postMessage('stop');
        }
      } else {
        kick();
      }
    } else if (m.type === 'stop') {
      if (pending && pending.tabId === m.tabId) pending = null;
      if (searching && cur && cur.tabId === m.tabId && !stopping) {
        stopping = true;
        sf.postMessage('stop');
      }
    }
  }

  connect();
})();
