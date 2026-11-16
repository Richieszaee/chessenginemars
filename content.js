// Bossfrommars Analysis Arrows — content script for chess.com
(function () {
  const Chess = (typeof window !== 'undefined' && window.BFMChess) || (typeof globalThis !== 'undefined' && globalThis.BFMChess);

  // ---------- pure chess & formatting helpers ----------
  const isMate = (L) => L && L.mate !== null && L.mate !== undefined;
  function fmtScore(L) {
    if (isMate(L)) return (L.mate > 0 ? 'M' : '-M') + Math.abs(L.mate);
    const v = L.cp / 100;
    return (v > 0 ? '+' : '') + v.toFixed(1);
  }
  function isNeg(L) { return isMate(L) ? L.mate < 0 : L.cp < 0; }
  function cpWhite(L) {
    if (isMate(L)) return L.mate > 0 ? 100000 - L.mate * 10 : -100000 - L.mate * 10;
    return L.cp;
  }
  function winProbWhite(L) {
    if (L && Array.isArray(L.wdl) && L.wdl.length === 3) {
      return (L.wdl[0] + 0.5 * L.wdl[1]) / 10;
    }
    if (isMate(L)) return L.mate > 0 ? 100 : 0;
    const cp = Math.max(-2000, Math.min(2000, L.cp || 0));
    return 100 / (1 + Math.exp(-0.00368208 * cp));
  }
  function barPct(L) {
    if (isMate(L)) return L.mate > 0 ? 100 : 0;
    const cp = Math.max(-1500, Math.min(1500, L.cp));
    return Math.max(4, Math.min(96, 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)));
  }
  function verdictText(L) {
    if (isMate(L)) return `${L.mate > 0 ? 'White' : 'Black'} can force mate in ${Math.abs(L.mate)}`;
    const a = Math.abs(L.cp), side = L.cp > 0 ? 'White' : 'Black';
    if (a < 35) return 'The position is equal';
    if (a < 100) return `${side} is slightly better`;
    if (a < 250) return `${side} is better`;
    return `${side} is winning`;
  }
  function moveQuality(i, best, M, turn) {
    if (i === 0) return ['Best', 'q-best'];
    const sideWinningMate = isMate(best) && ((best.mate > 0) === (turn === 'w'));
    if (sideWinningMate && !isMate(M) && Math.abs(cpWhite(M)) < 800) return ['Missed win', 'q-mis'];
    const wpLoss = (winProbWhite(best) - winProbWhite(M)) * (turn === 'w' ? 1 : -1);
    if (wpLoss <= 2.0) return ['Excellent', 'q-exc'];
    if (wpLoss <= 5.5) return ['Good', 'q-good'];
    if (wpLoss <= 12.0) return ['Inaccuracy', 'q-inac'];
    if (wpLoss <= 22.0) return ['Mistake', 'q-mis'];
    return ['Blunder', 'q-bln'];
  }
  function fmtNps(n) {
    if (!n || n <= 0) return '';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M nps';
    if (n >= 1000) return Math.round(n / 1000) + 'k nps';
    return n + ' nps';
  }
  function samePos(fenA, fenB) {
    if (!fenA || !fenB) return false;
    if (fenA === fenB) return true;
    const a = fenA.split(' '), b = fenB.split(' ');
    if (a.length < 3 || b.length < 3) return false;
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false;
    if (a[3] && b[3] && a[3] !== '-' && b[3] !== '-' && a[3] !== b[3]) return false;
    return true;
  }
  function pvToSan(ChessCtor, fen, pv, maxPlies) {
    if (!ChessCtor || !fen || !Array.isArray(pv) || !pv.length) return [];
    const out = [];
    try {
      const c = new ChessCtor(fen);
      const lim = Math.min(pv.length, maxPlies || 5);
      for (let i = 0; i < lim; i++) {
        const u = pv[i];
        if (!u || u.length < 4) break;
        const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        if (!m) break;
        out.push(m.san);
      }
    } catch (e) {}
    return out;
  }
  function buildHistoryFromPgn(ChessCtor, pgn, targetFen) {
    if (!ChessCtor || !pgn || typeof pgn !== 'string' || !targetFen) return null;
    try {
      const c = new ChessCtor();
      c.load_pgn(pgn, { sloppy: true });
      const hdr = c.header ? c.header() : {};
      const fullStartFen = (hdr && hdr.FEN) ? hdr.FEN : 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      let steps = 0;
      while (!samePos(c.fen(), targetFen) && steps < 400) {
        if (!c.undo()) break;
        steps++;
      }
      if (!samePos(c.fen(), targetFen)) return null;
      const moves = c.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
      return { startFen: fullStartFen, moves };
    } catch (e) {
      return null;
    }
  }

  class HistoryTracker {
    constructor(ChessCtor) {
      this.Chess = ChessCtor;
      this.stack = [];
    }
    resolve(fen, pgn) {
      const fromPgn = buildHistoryFromPgn(this.Chess, pgn, fen);
      if (fromPgn && fromPgn.moves.length > 0) {
        const prevStart = this.stack.length ? this.stack[0].fen : null;
        let newGame = !prevStart || !samePos(prevStart, fromPgn.startFen);
        if (!newGame) {
          const shared = Math.min(this.stack.length - 1, fromPgn.moves.length);
          for (let i = 0; i < shared; i++) {
            if (this.stack[i + 1].uci !== fromPgn.moves[i]) { newGame = true; break; }
          }
        }
        this.stack = [{ fen: fromPgn.startFen, uci: null }];
        try {
          const c = new this.Chess(fromPgn.startFen);
          for (const u of fromPgn.moves) {
            const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
            if (!m) break;
            this.stack.push({ fen: c.fen(), uci: u });
          }
        } catch (e) {}
        return { startFen: fromPgn.startFen, moves: fromPgn.moves, newGame };
      }

      for (let i = this.stack.length - 1; i >= 0; i--) {
        if (samePos(this.stack[i].fen, fen)) {
          this.stack = this.stack.slice(0, i + 1);
          const moves = this.stack.slice(1).map((x) => x.uci);
          return { startFen: this.stack[0].fen, moves, newGame: false };
        }
      }

      if (this.stack.length > 0 && this.Chess) {
        try {
          const tip = this.stack[this.stack.length - 1];
          const c = new this.Chess(tip.fen);
          const legal = c.moves({ verbose: true });
          for (const mv of legal) {
            c.move(mv);
            if (samePos(c.fen(), fen)) {
              const uci = mv.from + mv.to + (mv.promotion || '');
              this.stack.push({ fen, uci });
              return {
                startFen: this.stack[0].fen,
                moves: this.stack.slice(1).map((x) => x.uci),
                newGame: false
              };
            }
            c.undo();
          }
        } catch (e) {}
      }

      this.stack = [{ fen, uci: null }];
      return { startFen: fen, moves: [], newGame: true };
    }
    reset() { this.stack = []; }
  }

  class AnalysisCache {
    constructor(maxSize = 150) {
      this.maxSize = maxSize;
      this.map = new Map();
    }
    key(fen, engine, multipv) {
      return `${fen}|${engine}|${multipv}`;
    }
    get(fen, engine, multipv) {
      const k = this.key(fen, engine, multipv);
      const v = this.map.get(k);
      if (!v) return null;
      this.map.delete(k);
      this.map.set(k, v);
      return v;
    }
    set(fen, engine, multipv, depth, lines, meta) {
      const k = this.key(fen, engine, multipv);
      if (this.map.has(k)) this.map.delete(k);
      this.map.set(k, {
        depth,
        lines: lines.map((l) => (l ? { ...l, pv: l.pv ? l.pv.slice() : [], wdl: l.wdl ? l.wdl.slice() : null } : null)),
        meta: { ...meta }
      });
      if (this.map.size > this.maxSize) {
        const oldest = this.map.keys().next().value;
        this.map.delete(oldest);
      }
    }
    clear() { this.map.clear(); }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      fmtScore, isNeg, cpWhite, winProbWhite, barPct, verdictText,
      moveQuality, fmtNps, samePos, pvToSan, buildHistoryFromPgn,
      HistoryTracker, AnalysisCache
    };
  }
  if (typeof document === 'undefined' || typeof chrome === 'undefined') return;

  // ---------- extension runtime ----------
  const S = {
    on: true,
    engine: 'sf18-nnue',
    threads: 0,
    hash: 128,
    moves: 4,
    depth: 20,
    showPv: true,
    evalbar: 1,
    min: false,
    x: null,
    y: null,
    bgImage: ''
  };
  let pageFen = null, pageOver = false, pageFlipped = null, pageVariant = null, pagePgn = null;
  let loadingText = '', port = null, lastFen = null, lines = [], linesFen = null;
  let engineName = '', engineShort = '', activeThreads = 1, activeHash = 128, state = 'idle', nps = 0;
  let deepenFen = null;
  const cache = new AnalysisCache(150);
  const tracker = new HistoryTracker(Chess);
  const fenCheckCache = new Map();

  // ---------- settings ----------
  try {
    chrome.storage.local.get('bfm', (r) => {
      const v = (r && r.bfm) || {};
      for (const k in S) if (k in v) S[k] = v[k];
      if (!['sf18-nnue', 'lite-mt', 'lite'].includes(S.engine)) S.engine = 'sf18-nnue';
      buildPanel();
    });
  } catch (e) { buildPanel(); }
  function save() { try { chrome.storage.local.set({ bfm: S }); } catch (e) {} }
  function applyPanelBackground() {
    if (!panel) return;
    if (S.bgImage) panel.style.setProperty('--bfm-user-bg', `url("${S.bgImage}")`);
    else panel.style.removeProperty('--bfm-user-bg');
    const clear = panel.querySelector('.bfm-bg-clear');
    if (clear) clear.hidden = !S.bgImage;
  }

  // ---------- data from page world ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__bfm !== 'pos') return;
    pageFen = e.data.fen || null;
    pageOver = !!e.data.over;
    pageFlipped = typeof e.data.flipped === 'boolean' ? e.data.flipped : null;
    pageVariant = e.data.variant || null;
    if (e.data.pgn !== undefined) pagePgn = e.data.pgn;
  });

  // ---------- engine port ----------
  function getPort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: 'tab' });
      port.onMessage.addListener(onEngine);
      port.onDisconnect.addListener(() => {
        port = null;
        if (lastFen && S.on) {
          const f = lastFen;
          lastFen = null;
          setTimeout(() => request(f), 200);
        }
      });
    } catch (e) { port = null; }
    return port;
  }

  function request(fen, forceDeepen) {
    const targetDepth = (forceDeepen || deepenFen === fen) ? 99 : S.depth;
    if (!forceDeepen && deepenFen !== fen) deepenFen = null;

    lastFen = fen;
    linesFen = fen;
    loadingText = '';

    const cached = !forceDeepen ? cache.get(fen, S.engine, S.moves) : null;
    if (cached && cached.lines[0]) {
      lines = cached.lines.slice(0, S.moves);
      if (cached.meta) {
        engineName = cached.meta.engine || engineName;
        engineShort = cached.meta.engineShort || engineShort;
        activeThreads = cached.meta.threads || activeThreads;
        activeHash = cached.meta.hash || activeHash;
        nps = cached.lines[0].nps || nps;
      }
      if (cached.depth >= targetDepth && targetDepth < 99) {
        state = 'done';
        renderAll();
        return;
      }
    } else {
      lines = [];
    }

    state = 'thinking';
    const hist = tracker.resolve(fen, pagePgn);
    const p = getPort();
    if (p) {
      p.postMessage({
        type: 'go',
        fen,
        startFen: hist.startFen,
        moves: hist.moves,
        newGame: hist.newGame,
        chess960: pageVariant === 'chess960',
        multipv: S.moves,
        depth: targetDepth,
        engine: S.engine,
        threads: S.threads,
        hash: S.hash
      });
    }
    renderAll();
  }

  function stop() {
    if (lastFen && port) { try { port.postMessage({ type: 'stop' }); } catch (e) {} }
    lastFen = null; lines = []; linesFen = null; state = 'idle'; deepenFen = null;
  }

  function onEngine(m) {
    if (m.type === 'toggle') { toggle(); return; }
    if (m.type === 'error') { state = 'error'; renderPanel(); return; }
    if (m.type === 'status') {
      if (m.fen === lastFen && !lines[0]) { loadingText = m.text; renderPanel(); }
      return;
    }
    if (m.fen !== lastFen) return;
    if (m.engine) engineName = m.engine;
    if (m.engineShort) engineShort = m.engineShort;
    if (m.threads) activeThreads = m.threads;
    if (m.hash) activeHash = m.hash;

    if (m.type === 'info') {
      if (m.mpv <= S.moves) {
        lines[m.mpv - 1] = m;
        if (lines.length > S.moves) lines.length = S.moves;
        if (m.mpv === 1) nps = m.nps;
        if (lines[0]) {
          cache.set(m.fen, S.engine, S.moves, lines[0].depth, lines, {
            engine: engineName, engineShort, threads: activeThreads, hash: activeHash
          });
        }
        schedule();
      }
    } else if (m.type === 'done') {
      state = 'done';
      if (lines[0]) {
        cache.set(m.fen, S.engine, S.moves, lines[0].depth, lines, {
          engine: engineName, engineShort, threads: activeThreads, hash: activeHash
        });
      }
      schedule();
    }
  }

  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderAll(); }); }

  // ---------- board reading ----------
  function boardEl() {
    const cands = document.querySelectorAll('wc-chess-board, chess-board, #board-single, #board-play-computer, #board-vs-personalities, .board');
    for (const b of cands) if (b.querySelector('.piece')) return b;
    return null;
  }
  function sqOf(el) {
    for (const c of el.classList) {
      const m = /^square-(\d)(\d)$/.exec(c);
      if (m) return [+m[1] - 1, +m[2] - 1];
    }
    return null;
  }
  function domFen(b) {
    const g = Array.from({ length: 8 }, () => Array(8).fill(null));
    let n = 0;
    b.querySelectorAll('.piece').forEach((p) => {
      let t = null;
      for (const c of p.classList) if (/^[wb][prnbqk]$/.test(c)) t = c;
      const s = sqOf(p);
      if (!t || !s) return;
      g[7 - s[1]][s[0]] = t[0] === 'w' ? t[1].toUpperCase() : t[1];
      n++;
    });
    if (n < 2) return null;
    let turn = 'w';
    for (const h of b.querySelectorAll('.highlight')) {
      const s = sqOf(h);
      if (!s) continue;
      const pc = g[7 - s[1]][s[0]];
      if (pc) { turn = pc === pc.toUpperCase() ? 'b' : 'w'; break; }
    }
    const place = g.map((r) => {
      let o = '', e = 0;
      for (const c of r) { if (!c) e++; else { if (e) o += e; e = 0; o += c; } }
      return o + (e || '');
    }).join('/');
    let cs = '';
    if (g[7][4] === 'K') { if (g[7][7] === 'R') cs += 'K'; if (g[7][0] === 'R') cs += 'Q'; }
    if (g[0][4] === 'k') { if (g[0][7] === 'r') cs += 'k'; if (g[0][0] === 'r') cs += 'q'; }
    let fen = `${place} ${turn} ${cs || '-'} - 0 1`;
    if (!legalFen(fen)) {
      fen = `${place} ${turn === 'w' ? 'b' : 'w'} ${cs || '-'} - 0 1`;
      if (!legalFen(fen)) return null;
    }
    return fen;
  }
  function legalFen(fen) {
    if (fenCheckCache.has(fen)) return fenCheckCache.get(fen);
    let ok = false;
    try {
      const c = new Chess();
      if (c.validate_fen(fen).valid) {
        c.load(fen);
        const p = fen.split(' ');
        p[1] = p[1] === 'w' ? 'b' : 'w';
        p[3] = '-';
        const o = new Chess(p.join(' '));
        if (!o.in_check()) {
          const b = c.board().flat().filter(Boolean);
          ok = b.filter((x) => x.type === 'k' && x.color === 'w').length === 1 &&
               b.filter((x) => x.type === 'k' && x.color === 'b').length === 1;
        }
      }
    } catch (e) { ok = false; }
    if (fenCheckCache.size > 200) fenCheckCache.clear();
    fenCheckCache.set(fen, ok);
    return ok;
  }
  function currentFen(b) {
    if (pageFen && legalFen(pageFen)) return pageFen;
    return domFen(b);
  }
  function isFlipped(b) { return pageFlipped !== null ? pageFlipped : b.classList.contains('flipped'); }

  // ---------- where it's allowed ----------
  function allowedHere() {
    const p = location.pathname;
    if (/^\/analysis(\/|$)/.test(p)) return 'ok';
    if (/^\/(play\/)?(computer|bots?)(\/|$)/.test(p)) return 'ok';
    if (/^\/game\/(computer|bot)(\/|$)/.test(p)) return 'ok';
    if (/^\/play(\/|$)/.test(p)) return 'ok';
    if (/^\/game(\/|$)/.test(p)) return 'ok';
    return 'off';
  }

  // ---------- arrows ----------
  const BEST = '#5cb82e', ALT = '#3f95e6', REPLY = '#63d9e8';
  let hoverIdx = -1;
  function xy(sq, flip) {
    const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
    return flip ? [7 - f + .5, r + .5] : [f + .5, 7 - r + .5];
  }
  function arrow(u, flip, color, w, opacity, num, dashed) {
    const [ax, ay] = xy(u.slice(0, 2), flip), [bx, by] = xy(u.slice(2, 4), flip);
    const fx = Math.abs(bx - ax), fy = Math.abs(by - ay);
    const knight = (fx === 1 && fy === 2) || (fx === 2 && fy === 1);
    const hl = dashed ? .28 : .36, hw = w * 2.5;
    const dashAttr = dashed ? ' stroke-dasharray="0.18 0.12"' : '';
    let path, ex, ey, nx, ny;
    if (knight) {
      const mx = fy === 2 ? ax : bx, my = fy === 2 ? by : ay;
      const l = Math.hypot(bx - mx, by - my); nx = (bx - mx) / l; ny = (by - my) / l;
      ex = bx - nx * hl; ey = by - ny * hl;
      path = `<polyline points="${ax},${ay} ${mx},${my} ${ex},${ey}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round"${dashAttr}/>`;
    } else {
      const l = Math.hypot(bx - ax, by - ay); nx = (bx - ax) / l; ny = (by - ay) / l;
      ex = bx - nx * hl; ey = by - ny * hl;
      path = `<line x1="${ax + nx * .2}" y1="${ay + ny * .2}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="${w}"${dashAttr}/>`;
    }
    const head = `<polygon points="${bx},${by} ${ex - ny * hw / 2},${ey + nx * hw / 2} ${ex + ny * hw / 2},${ey - nx * hw / 2}" fill="${color}"/>`;
    const badge = num ? `<g opacity="${Math.max(opacity, .9)}"><circle cx="${bx + .3}" cy="${by - .3}" r=".16" fill="${color}" stroke="#fff" stroke-width=".03"/><text x="${bx + .3}" y="${by - .245}" font-size=".19" font-weight="800" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif">${num}</text></g>` : '';
    return { a: `<g opacity="${opacity}">${path}${head}</g>`, badge };
  }
  function svgFor(b) {
    let s = b.querySelector(':scope > svg.bfm-svg');
    if (!s) {
      if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
      s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('class', 'bfm-svg');
      s.setAttribute('viewBox', '0 0 8 8');
      b.appendChild(s);
    }
    return s;
  }
  function drawArrows() {
    const b = boardEl(); if (!b) return;
    const s = svgFor(b);
    if (!S.on || allowedHere() !== 'ok' || linesFen !== lastFen) { s.innerHTML = ''; return; }
    const flip = isFlipped(b);
    let h = '', badges = '';
    const n = Math.min(S.moves, lines.length);
    for (let i = n - 1; i >= 0; i--) {
      const L = lines[i];
      if (!L || !L.pv || !L.pv[0]) continue;
      let op = i === 0 ? .9 : .5;
      if (hoverIdx >= 0) op = i === hoverIdx ? .95 : .12;
      const r = arrow(L.pv[0], flip, i === 0 ? BEST : ALT, i === 0 ? .22 : .14, op, n > 1 ? i + 1 : 0, false);
      h += r.a;
      if (hoverIdx < 0 || hoverIdx === i) badges = r.badge + badges;
    }
    if (S.showPv && hoverIdx >= 0 && lines[hoverIdx] && lines[hoverIdx].pv && lines[hoverIdx].pv[1]) {
      const reply = arrow(lines[hoverIdx].pv[1], flip, REPLY, .12, .85, 0, true);
      h += reply.a;
    }
    s.innerHTML = h + badges;
  }

  // ---------- panel ----------
  let panel = null;
  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'bfm-panel';
    panel.innerHTML = `
      <div class="bfm-head"><span class="bfm-logo" aria-hidden="true"></span><b>Bossfrommars</b><span class="bfm-brand-tag">NNUE ENGINE</span><span class="bfm-sp"></span>
        <button class="bfm-tg" role="switch" aria-label="Show analysis arrows" title="Arrows on/off (Alt+A)"></button>
        <button class="bfm-ib bfm-gear" aria-label="Settings" title="Settings">⚙</button>
        <button class="bfm-ib bfm-min" aria-label="Minimise panel" title="Minimise">–</button></div>
      <div class="bfm-body">
        <div class="bfm-evalrow">
          <div class="bfm-score">…</div>
          <div class="bfm-bar"><div class="bfm-barw"></div></div>
        </div>
        <div class="bfm-verdict">Waiting for board…</div>
        <div class="bfm-wdl" hidden>
          <div class="bfm-wdl-bar"><span class="bfm-wdl-w"></span><span class="bfm-wdl-d"></span><span class="bfm-wdl-l"></span></div>
          <div class="bfm-wdl-txt"></div>
        </div>
        <div class="bfm-turn"></div>
        <div class="bfm-list"></div>
        <div class="bfm-foot"><span class="bfm-foot-txt"></span><button class="bfm-deep" type="button" hidden title="Keep thinking deeper on this position (∞)">∞ Deepen</button></div>
        <div class="bfm-set">
          <label>Engine <select data-k="engine">
            <option value="sf18-nnue">SF 18 NNUE · 11MB (strongest)</option>
            <option value="lite-mt">SF 19 Lite · Multi-thread</option>
            <option value="lite">SF 19 Lite · 1 thread</option>
          </select></label>
          <label>CPU Threads <select data-k="threads">
            <option value="0">Auto (optimal)</option>
            <option value="1">1 thread</option>
            <option value="2">2 threads</option>
            <option value="4">4 threads</option>
            <option value="8">8 threads</option>
            <option value="16">16 threads</option>
          </select></label>
          <label>Hash table <select data-k="hash">
            <option value="64">64 MB</option>
            <option value="128">128 MB</option>
            <option value="256">256 MB</option>
          </select></label>
          <label>Eval bar <select data-k="evalbar"><option value="1">Left of board</option><option value="2">Right of board</option><option value="0">Off</option></select></label>
          <label>Moves shown <select data-k="moves"><option value="1">1 · max strength</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
          <label>Engine depth <select data-k="depth">
            <option value="14">14 · fast</option>
            <option value="16">16 · quick</option>
            <option value="18">18</option>
            <option value="20">20 · strong</option>
            <option value="24">24 · master</option>
            <option value="28">28 · grandmaster</option>
            <option value="99">∞ · keep thinking</option>
          </select></label>
          <label>Continuation PV <select data-k="showPv"><option value="1">Show lines & reply</option><option value="0">Moves only</option></select></label>
          <div class="bfm-bg-setting"><span class="bfm-bg-label">Panel background</span><div class="bfm-bg-actions"><label class="bfm-upload">Choose image<input class="bfm-bg-file" type="file" accept="image/*" aria-label="Upload a panel background image"></label><button class="bfm-bg-clear" type="button">Remove</button></div><small>Image stays on this device. Best with dark images.</small></div>
        </div>
      </div>`;
    document.documentElement.appendChild(panel);
    if (S.x !== null) { panel.style.left = S.x + 'px'; panel.style.top = S.y + 'px'; panel.style.right = 'auto'; }

    panel.querySelectorAll('select').forEach((sel) => {
      const k = sel.dataset.k;
      sel.value = k === 'showPv' ? (S.showPv ? '1' : '0') : String(S[k]);
      sel.onchange = () => {
        if (k === 'showPv') S.showPv = sel.value === '1';
        else if (k === 'engine') S.engine = sel.value;
        else S[k] = +sel.value;
        save();
        if (k === 'engine' || k === 'threads' || k === 'hash' || k === 'moves' || k === 'depth') {
          cache.clear();
          deepenFen = null;
          lastFen = null;
        }
        renderAll();
      };
    });

    panel.querySelector('.bfm-deep').onclick = () => {
      if (!lastFen) return;
      if (deepenFen === lastFen && state === 'thinking') {
        deepenFen = null;
        if (port) { try { port.postMessage({ type: 'stop' }); } catch (e) {} }
        state = 'done';
        renderPanel();
      } else {
        deepenFen = lastFen;
        request(lastFen, true);
      }
    };

    const bgFile = panel.querySelector('.bfm-bg-file');
    bgFile.onchange = () => {
      const file = bgFile.files && bgFile.files[0];
      if (!file) return;
      const note = panel.querySelector('.bfm-bg-setting small');
      if (!file.type.startsWith('image/')) { note.textContent = 'Please choose an image file.'; bgFile.value = ''; return; }
      if (file.size > 20 * 1024 * 1024) { note.textContent = 'That image is too large. Choose one under 20 MB.'; bgFile.value = ''; return; }
      note.textContent = 'Preparing your image…';
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        try {
          const max = 1200, scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          S.bgImage = canvas.toDataURL('image/webp', .78);
          save(); applyPanelBackground();
          note.textContent = 'Saved on this device. Best with dark images.';
        } catch (e) { note.textContent = 'Could not use that image. Try another file.'; }
        URL.revokeObjectURL(url); bgFile.value = '';
      };
      img.onerror = () => { note.textContent = 'Could not read that image. Try another file.'; URL.revokeObjectURL(url); bgFile.value = ''; };
      img.src = url;
    };
    panel.querySelector('.bfm-bg-clear').onclick = () => {
      S.bgImage = ''; save(); applyPanelBackground();
      panel.querySelector('.bfm-bg-setting small').textContent = 'Image stays on this device. Best with dark images.';
    };
    applyPanelBackground();
    panel.querySelector('.bfm-tg').onclick = toggle;
    panel.querySelector('.bfm-min').onclick = () => { S.min = !S.min; save(); renderPanel(); };
    panel.querySelector('.bfm-gear').onclick = () => panel.classList.toggle('bfm-showset');

    const list = panel.querySelector('.bfm-list');
    list.addEventListener('mouseover', (e) => {
      const r = e.target.closest('.bfm-mv');
      const i = r ? +r.dataset.i : -1;
      if (i !== hoverIdx) { hoverIdx = i; drawArrows(); }
    });
    list.addEventListener('mouseleave', () => { hoverIdx = -1; drawArrows(); });

    const head = panel.querySelector('.bfm-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = panel.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const mv = (ev) => {
        S.x = Math.max(0, Math.min(innerWidth - 60, ev.clientX - ox));
        S.y = Math.max(0, Math.min(innerHeight - 30, ev.clientY - oy));
        panel.style.left = S.x + 'px'; panel.style.top = S.y + 'px'; panel.style.right = 'auto';
      };
      const up = () => { head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); save(); };
      head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up);
    });
    document.addEventListener('keydown', (e) => { if (e.altKey && (e.key === 'a' || e.key === 'A')) { toggle(); e.preventDefault(); } });
    renderPanel();
  }

  function toggle() { S.on = !S.on; save(); if (!S.on) stop(); renderAll(); }
  function message(icon, title, sub) {
    const q = (s) => panel.querySelector(s);
    q('.bfm-score').textContent = icon; q('.bfm-score').className = 'bfm-score';
    q('.bfm-barw').style.width = '50%';
    q('.bfm-verdict').textContent = title; q('.bfm-turn').textContent = sub || '';
    q('.bfm-wdl').hidden = true;
    q('.bfm-list').innerHTML = '';
    q('.bfm-foot-txt').textContent = '';
    q('.bfm-deep').hidden = true;
  }

  function renderPanel() {
    if (!panel) return;
    const here = allowedHere(), b = boardEl();
    panel.classList.toggle('bfm-hidden', here === 'off');
    panel.classList.toggle('bfm-minimised', !!S.min);
    panel.querySelector('.bfm-tg').classList.toggle('on', S.on);
    panel.querySelector('.bfm-tg').setAttribute('aria-checked', String(!!S.on));
    panel.querySelector('.bfm-min').setAttribute('aria-label', S.min ? 'Expand panel' : 'Minimise panel');

    if (here === 'ok' && !b) return message('…', 'Looking for the board…');
    if (!S.on) return message('Off', 'Arrows are off', 'Click the switch or press Alt+A');
    if (state === 'error') return message('!', 'Engine failed to load', 'Try reloading the page');
    if (state === 'over') return message('#', 'Game over', 'No moves left in this position');

    const fresh = linesFen === lastFen && lines[0];
    if (!fresh) return message('…', lastFen ? (loadingText || 'Thinking…') : 'Waiting for board…');

    const best = lines[0], turn = linesFen.split(' ')[1];
    const sc = panel.querySelector('.bfm-score');
    sc.textContent = fmtScore(best);
    sc.className = 'bfm-score' + (isNeg(best) ? ' neg' : '');
    panel.querySelector('.bfm-barw').style.width = barPct(best) + '%';
    panel.querySelector('.bfm-verdict').textContent = verdictText(best);

    const wdlBox = panel.querySelector('.bfm-wdl');
    if (Array.isArray(best.wdl) && best.wdl.length === 3) {
      const wPct = Math.round(best.wdl[0] / 10);
      const dPct = Math.round(best.wdl[1] / 10);
      const lPct = Math.max(0, 100 - wPct - dPct);
      wdlBox.hidden = false;
      wdlBox.querySelector('.bfm-wdl-w').style.width = wPct + '%';
      wdlBox.querySelector('.bfm-wdl-d').style.width = dPct + '%';
      wdlBox.querySelector('.bfm-wdl-l').style.width = lPct + '%';
      wdlBox.querySelector('.bfm-wdl-txt').textContent = `W ${wPct}% · D ${dPct}% · L ${lPct}%`;
    } else {
      wdlBox.hidden = true;
    }

    const validCount = Math.min(S.moves, lines.filter(Boolean).length);
    panel.querySelector('.bfm-turn').innerHTML = `<span class="bfm-pawn ${turn}"></span>${turn === 'w' ? 'White' : 'Black'} to move — top ${validCount} move${S.moves > 1 ? 's' : ''}:`;

    let h = '';
    for (let i = 0; i < S.moves; i++) {
      const M = lines[i];
      if (!M || !M.pv || !M.pv[0]) {
        h += `<div class="bfm-mv empty"><span class="bfm-num">${i + 1}</span><b>…</b></div>`;
        continue;
      }
      const sanList = pvToSan(Chess, linesFen, M.pv, S.showPv ? 5 : 1);
      const moveSan = sanList[0] || M.pv[0];
      const [q, qc] = moveQuality(i, best, M, turn);
      const pvLine = S.showPv && sanList.length > 1 ? `<div class="bfm-pv">↳ ${sanList.slice(1).join(' ')}</div>` : '';
      h += `<div class="bfm-mv${i === 0 ? ' top' : ''}" data-i="${i}"><div class="bfm-mv-main"><span class="bfm-num">${i + 1}</span><b>${moveSan}</b><span class="bfm-q ${qc}">${q}</span><span class="bfm-e${isNeg(M) ? ' neg' : ''}">${fmtScore(M)}</span></div>${pvLine}</div>`;
    }
    panel.querySelector('.bfm-list').innerHTML = h;

    const thrTxt = `${activeThreads || 1}T`;
    const npsTxt = fmtNps(best.nps);
    const sdTxt = best.seldepth ? `/${best.seldepth}` : '';
    const statusTxt = state === 'done' ? 'done' : '…';
    panel.querySelector('.bfm-foot-txt').textContent = `${engineShort || engineName || 'Stockfish'} · ${thrTxt} · d${best.depth}${sdTxt}${npsTxt ? ' · ' + npsTxt : ''} · ${statusTxt}`;

    const deepBtn = panel.querySelector('.bfm-deep');
    if (S.depth >= 99 && state === 'thinking') {
      deepBtn.hidden = true;
    } else if (deepenFen === lastFen && state === 'thinking') {
      deepBtn.hidden = false;
      deepBtn.textContent = 'Stop ∞';
      deepBtn.classList.add('active');
    } else {
      deepBtn.hidden = false;
      deepBtn.textContent = '∞ Deepen';
      deepBtn.classList.remove('active');
    }
  }

  // ---------- eval bar next to the board ----------
  let bar = null;
  function buildBar() {
    bar = document.createElement('div');
    bar.className = 'bfm-evalbar';
    bar.innerHTML = '<div class="bfm-eb-w"></div><div class="bfm-eb-mid"></div><span class="bfm-eb-l"></span>';
    document.documentElement.appendChild(bar);
  }
  function renderBar() {
    if (!bar) buildBar();
    const b = boardEl();
    const fresh = linesFen === lastFen && lines[0];
    const show = b && S.on && S.evalbar && allowedHere() === 'ok' && (fresh || state === 'over' || state === 'thinking');
    if (!show) { bar.style.display = 'none'; return; }
    const r = b.getBoundingClientRect();
    if (r.width < 50) { bar.style.display = 'none'; return; }
    const w = Math.max(14, Math.round(r.width * 0.035)), gap = 6;
    Object.assign(bar.style, {
      display: 'block', width: w + 'px', height: r.height + 'px', top: r.top + 'px',
      left: (S.evalbar === 2 ? r.right + gap : r.left - gap - w) + 'px'
    });
    const flip = isFlipped(b);
    bar.classList.toggle('flip', flip);
    let pct = 50, txt = '', whiteAhead = true;
    if (fresh) {
      const L = lines[0];
      pct = barPct(L);
      whiteAhead = isMate(L) ? L.mate > 0 : L.cp >= 0;
      txt = isMate(L) ? 'M' + Math.abs(L.mate) : Math.abs(L.cp / 100).toFixed(1);
    } else if (state === 'over') {
      try {
        const c = new Chess(lastFen);
        if (c.in_checkmate()) {
          whiteAhead = c.turn() === 'b';
          pct = whiteAhead ? 100 : 0;
          txt = whiteAhead ? '1-0' : '0-1';
        } else txt = '½';
      } catch (e) {}
    }
    bar.querySelector('.bfm-eb-w').style.height = pct + '%';
    const l = bar.querySelector('.bfm-eb-l');
    l.textContent = txt;
    const atBottom = whiteAhead !== flip;
    l.className = 'bfm-eb-l ' + (atBottom ? 'bot' : 'top') + (whiteAhead ? ' onw' : ' onb');
    l.style.fontSize = Math.max(9, Math.round(w * 0.42)) + 'px';
  }
  addEventListener('scroll', () => renderBar(), { passive: true, capture: true });
  addEventListener('resize', () => renderBar());

  function renderAll() { drawArrows(); renderPanel(); renderBar(); }

  // ---------- main loop ----------
  function tick() {
    const b = boardEl();
    const here = allowedHere();
    if (!b || !S.on || here !== 'ok' || document.visibilityState !== 'visible') {
      if (lastFen) stop();
      renderAll();
      return;
    }
    const fen = currentFen(b);
    if (!fen) { renderAll(); return; }
    let over = pageOver && pageFen && samePos(pageFen, fen);
    if (!over) {
      try { const c = new Chess(fen); over = c.game_over(); } catch (e) {}
    }
    if (over) {
      if (lastFen !== fen || state !== 'over') {
        stop();
        lastFen = fen;
        state = 'over';
      }
      renderAll();
      return;
    }
    if (fen !== lastFen) request(fen);
    else { drawArrows(); renderBar(); }
  }
  setInterval(tick, 250);
})();
