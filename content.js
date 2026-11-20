// Bossfrommars Analysis — content script for chess.com
// Live arrows, eval bar and chess.com-style move labels (Brilliant, Great, Best, Blunder…)
(function () {
  const Chess = window.BFMChess;
  const R = window.BFMReview;
  const I = window.BFMIcons;

  const DEFAULTS = {
    on: true, moves: 3, depth: 20, evalbar: 1, min: false, x: null, y: null, bgImage: '',
    labels: true, popup: true, boardBadge: true, book: true, force: false
  };
  const S = Object.assign({}, DEFAULTS);

  let pageFen = null, pageFlipped = null, pageOver = false;
  let port = null, lastFen = null, lines = [], linesFen = null;
  let state = 'idle', nps = 0, engineName = '', loadingText = '';
  let pendingCheck = null;      // move waiting to be classified
  let chain = [];               // [{fen, san}] positions we have walked through
  let lastRecord = null;        // most recently labelled move
  let moveLog = [];             // labelled moves for the recent strip
  let hoverIdx = -1;
  let labelsLost = false;       // couldn't grade a move because we had no prior eval
  let panel = null, bar = null, toastEl = null, toastTimer = 0;
  const MIN_DEPTH = 11;         // label once the new position has some depth

  // ---------- settings ----------
  try {
    chrome.storage.local.get('bfm', (r) => {
      const v = (r && r.bfm) || {};
      for (const k in S) if (k in v) S[k] = v[k];
      buildPanel(); renderAll();
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

  // ---------- data from the page world ----------
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.__bfm !== 'pos') return;
    if (e.source && e.source !== window) return;
    pageFen = e.data.fen || null;
    pageFlipped = typeof e.data.flipped === 'boolean' ? e.data.flipped : null;
    pageOver = !!e.data.over;
  });

  // ---------- engine port ----------
  function getPort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: 'tab' });
      port.onMessage.addListener(onEngine);
      port.onDisconnect.addListener(() => {
        port = null;
        if (lastFen) { const f = lastFen; lastFen = null; setTimeout(() => request(f), 200); }
      });
    } catch (e) { port = null; }
    return port;
  }
  function request(fen) {
    lastFen = fen; lines = []; linesFen = fen; state = 'thinking'; loadingText = '';
    const p = getPort();
    if (p) p.postMessage({ type: 'go', fen, multipv: S.moves, depth: S.depth, engine: 'lite' });
    renderAll();
  }
  function stop() {
    if (lastFen && port) { try { port.postMessage({ type: 'stop' }); } catch (e) {} }
    lastFen = null; lines = []; linesFen = null; state = 'idle'; pendingCheck = null;
  }
  function onEngine(m) {
    if (m.type === 'error') { state = 'error'; renderPanel(); return; }
    if (m.type === 'status') { if (m.fen === lastFen && !lines[0]) { loadingText = m.text; renderPanel(); } return; }
    if (m.fen !== lastFen) return;
    if (m.engine) engineName = m.engine;
    if (m.type === 'info') {
      lines[m.mpv - 1] = m;
      if (m.mpv === 1) nps = m.nps;
      if (m.mpv === 1 && state === 'done') state = 'thinking';
      maybeFinalize();
      schedule();
    } else if (m.type === 'done') {
      state = 'done';
      maybeFinalize();
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
  function sqOf(el) { for (const c of el.classList) { const m = /^square-(\d)(\d)$/.exec(c); if (m) return [+m[1] - 1, +m[2] - 1]; } return null; }
  function domFen(b) {
    const g = Array.from({ length: 8 }, () => Array(8).fill(null));
    let n = 0;
    b.querySelectorAll('.piece').forEach((p) => {
      let t = null; for (const c of p.classList) if (/^[wb][prnbqk]$/.test(c)) t = c;
      const s = sqOf(p); if (!t || !s) return;
      g[7 - s[1]][s[0]] = t[0] === 'w' ? t[1].toUpperCase() : t[1]; n++;
    });
    if (n < 2) return null;
    let turn = 'w';
    for (const h of b.querySelectorAll('.highlight')) {
      const s = sqOf(h); if (!s) continue;
      const pc = g[7 - s[1]][s[0]];
      if (pc) { turn = pc === pc.toUpperCase() ? 'b' : 'w'; break; }
    }
    const place = g.map((r) => { let o = '', e = 0; for (const c of r) { if (!c) e++; else { if (e) o += e; e = 0; o += c; } } return o + (e || ''); }).join('/');
    let cs = '';
    if (g[7][4] === 'K') { if (g[7][7] === 'R') cs += 'K'; if (g[7][0] === 'R') cs += 'Q'; }
    if (g[0][4] === 'k') { if (g[0][7] === 'r') cs += 'k'; if (g[0][0] === 'r') cs += 'q'; }
    let fen = `${place} ${turn} ${cs || '-'} - 0 1`;
    if (!legalFen(fen)) { fen = `${place} ${turn === 'w' ? 'b' : 'w'} ${cs || '-'} - 0 1`; if (!legalFen(fen)) return null; }
    return fen;
  }
  const fenMemo = new Map();
  function memo(key, fn) {
    if (fenMemo.has(key)) return fenMemo.get(key);
    const v = fn();
    if (fenMemo.size > 400) fenMemo.clear();
    fenMemo.set(key, v);
    return v;
  }
  function legalFen(fen) { return memo('L' + fen, () => legalFenRaw(fen)); }
  function legalFenRaw(fen) {
    try {
      const c = new Chess();
      if (!c.validate_fen(fen).valid) return false;
      c.load(fen);
      const p = fen.split(' '); p[1] = p[1] === 'w' ? 'b' : 'w'; p[3] = '-';
      const o = new Chess(p.join(' '));
      if (o.in_check()) return false;
      const b = c.board().flat().filter(Boolean);
      return b.filter((x) => x.type === 'k' && x.color === 'w').length === 1 &&
             b.filter((x) => x.type === 'k' && x.color === 'b').length === 1;
    } catch (e) { return false; }
  }
  function currentFen(b) {
    if (pageFen && legalFen(pageFen)) return pageFen;
    return domFen(b);
  }
  function isFlipped(b) { return pageFlipped !== null ? pageFlipped : b.classList.contains('flipped'); }
  function allowedHere() {
    if (S.force) return 'ok';
    const p = location.pathname;
    if (/^\/analysis(\/|$)/.test(p)) return 'ok';
    if (/^\/(play\/)?(computer|bots?)(\/|$)/.test(p)) return 'ok';
    if (/^\/game\/(computer|bot)(\/|$)/.test(p)) return 'ok';
    if (/^\/play(\/|$)/.test(p)) return 'ok';
    if (/^\/game(\/|$)/.test(p)) return 'ok';
    return 'off';
  }
  function boardKey(fen) { return fen.split(' ').slice(0, 2).join(' '); }
  function moveBetween(fromFen, toFen) {
    try {
      const target = boardKey(toFen);
      const c = new Chess(fromFen);
      for (const m of c.moves({ verbose: true })) {
        const t = new Chess(fromFen);
        const r = t.move({ from: m.from, to: m.to, promotion: m.promotion });
        if (r && boardKey(t.fen()) === target) return { from: r.from, to: r.to, san: r.san, piece: r.piece, color: r.color, flags: r.flags, promotion: r.promotion, before: fromFen, after: toFen };
      }
    } catch (e) {}
    return null;
  }
  function sideToMove(fen) { return (fen.split(' ')[1] || 'w'); }
  function gameOverFen(fen) { return memo('O' + fen, () => { try { return new Chess(fen).game_over(); } catch (e) { return false; } }); }

  // ---------- move labels ----------
  function keyOf(fen) { return fen.split(' ').slice(0, 2).join(' '); }

  function samePos(a, b) { return !!a && !!b && keyOf(a) === keyOf(b); }

  // record a new position; keeps the SAN chain so the opening book works
  function visit(fen, prevFen) {
    // keep the move chain in sync even before the user enables labels
    if (!chain.length) {
      chain.push({ fen, san: null });
      return;
    }
    const last = chain[chain.length - 1];
    if (samePos(last.fen, fen)) { last.fen = fen; return; }
    if (prevFen && samePos(prevFen, last.fen)) {
      const mv = moveBetween(last.fen, fen);
      if (mv) { chain.push({ fen, san: mv.san }); if (chain.length > 48) chain.shift(); return; }
    }
    // jumped (new game, page swapped, user rewound) — restart the chain
    chain = [{ fen, san: null }];
    moveLog = [];
    lastRecord = null;
    labelsLost = false;
  }

  function noteTransition(prevFen, prevLines, newFen) {
    pendingCheck = null;
    if (!S.labels) return;
    const bestLine = prevLines && prevLines[0];
    const mv = moveBetween(prevFen, newFen);
    if (!mv) return;
    if (!bestLine || !bestLine.pv || !bestLine.pv[0]) {
      // no reference evaluation (page loaded mid-game, or analysis was off for a moment)
      if (S.labels && sanSequence().length) labelsLost = true;
      return;
    }
    pendingCheck = { prevFen, prevLines: prevLines.slice(), mv, at: Date.now(), seqBefore: sanSequence() };
  }

  function sanSequence() {
    return chain.filter((c) => c.san).map((c) => c.san);
  }

  function commit(rec) {
    lastRecord = rec;
    moveLog.push(rec);
    if (moveLog.length > 24) moveLog.shift();
    pendingCheck = null;
    if (S.popup && rec.label !== 'forced' && rec.label !== 'none') showToast(rec);
    renderAll();
  }

  function buildRecord(playedCp, bestCp, secondCp, opts) {
    const pc = pendingCheck;
    const turn = sideToMove(pc.prevFen);
    const wpFor = (v) => (turn === 'w' ? R.winProb(v) : 1 - R.winProb(v));
    const gap = secondCp === null || secondCp === undefined ? null : (wpFor(bestCp) - wpFor(secondCp)) * 100;
    const bestUci = pc.prevLines[0].pv[0];
    const playedUci = pc.mv.from + pc.mv.to + (pc.mv.promotion || '');
    const facts = R.facts(pc.prevFen, pc.mv, bestUci, gap);
    const seq = (pc.seqBefore || []).concat([pc.mv.san]);
    const book = !!(S.book && R.isBook(seq));
    const label = R.classify({
      fen: pc.prevFen, playedUci, bestUci, bestCp, secondCp, playedCp,
      book, facts, forced: facts.onlyMove, mateAfter: !!(opts && opts.mated)
    });
    const moveNo = parseInt((pc.prevFen.split(' ')[5] || '1'), 10) || 1;
    return {
      san: pc.mv.san, label, drop: R.clamp((wpFor(bestCp) - wpFor(playedCp)) * 100, 0, 100),
      cp: playedCp, bestCp, to: pc.mv.to, from: pc.mv.from, color: pc.mv.color,
      moveNo, ply: seq.length, fenAfter: opts && opts.fenAfter ? opts.fenAfter : lastFen, book
    };
  }

  function maybeFinalize() {
    if (!pendingCheck || !lastFen) return;
    const overNow = state === 'over' || gameOverFen(lastFen);
    const cur = lines[0];
    const bestCp = (() => { const b = pendingCheck.prevLines[0]; return b ? R.evalOf(b) : null; })();
    if (bestCp === null) { pendingCheck = null; return; }
    let playedCp = cur ? R.evalOf(cur) : null;
    if (playedCp === null) {
      if (!overNow) return;
      playedCp = sideToMove(lastFen) === 'w' ? -(R.MATE - 100) : (R.MATE - 100);
    }
    if (cur && !overNow && cur.depth < MIN_DEPTH && state !== 'done') return;
    const secondCp = pendingCheck.prevLines[1] ? R.evalOf(pendingCheck.prevLines[1]) : null;
    commit(buildRecord(playedCp, bestCp, secondCp, { fenAfter: lastFen }));
  }

  // a checkmate delivered on the board: no engine lines needed
  function finalizeMate() {
    if (!pendingCheck) return;
    const bestLine = pendingCheck.prevLines[0];
    const bestCp = bestLine ? R.evalOf(bestLine) : null;
    if (bestCp === null) { pendingCheck = null; return; }
    const overFen = pendingCheck.mv.after;
    const playedCp = sideToMove(overFen) === 'w' ? -(R.MATE - 100) : (R.MATE - 100);
    commit(buildRecord(playedCp, bestCp, null, { fenAfter: overFen, mated: true }));
  }

  // ---------- arrows ----------
  const BEST = '#7fd44a', ALT = '#4aa3e8';
  function xy(sq, flip) { const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1; return flip ? [7 - f + .5, r + .5] : [f + .5, 7 - r + .5]; }
  function arrow(u, flip, color, w, opacity, num) {
    const [ax, ay] = xy(u.slice(0, 2), flip), [bx, by] = xy(u.slice(2, 4), flip);
    const fx = Math.abs(bx - ax), fy = Math.abs(by - ay);
    const knight = (fx === 1 && fy === 2) || (fx === 2 && fy === 1);
    const hl = .36, hw = w * 2.5;
    let path, ex, ey, nx, ny;
    if (knight) {
      const mx = fy === 2 ? ax : bx, my = fy === 2 ? by : ay;
      const l = Math.hypot(bx - mx, by - my); nx = (bx - mx) / l; ny = (by - my) / l;
      ex = bx - nx * hl; ey = by - ny * hl;
      path = `<polyline points="${ax},${ay} ${mx},${my} ${ex},${ey}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round"/>`;
    } else {
      const l = Math.hypot(bx - ax, by - ay); nx = (bx - ax) / l; ny = (by - ay) / l;
      ex = bx - nx * hl; ey = by - ny * hl;
      path = `<line x1="${ax + nx * .2}" y1="${ay + ny * .2}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="${w}"/>`;
    }
    const head = `<polygon points="${bx},${by} ${ex - ny * hw / 2},${ey + nx * hw / 2} ${ex + ny * hw / 2},${ey - nx * hw / 2}" fill="${color}"/>`;
    const badge = num ? `<g opacity="${Math.max(opacity, .92)}"><circle cx="${bx + .3}" cy="${by - .3}" r=".17" fill="${color}" stroke="#fff" stroke-width=".03"/><text x="${bx + .3}" y="${by - .245}" font-size=".2" font-weight="800" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif">${num}</text></g>` : '';
    return { a: `<g opacity="${opacity}">${path}${head}</g>`, badge };
  }
  function svgFor(b) {
    let s = b.querySelector(':scope > svg.bfm-svg');
    if (!s) {
      if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
      s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('class', 'bfm-svg'); s.setAttribute('viewBox', '0 0 8 8');
      b.appendChild(s);
    }
    return s;
  }
  function badgeMarkup(rec, flip) {
    const info = R.info(rec.label);
    if (!info.label) return '';
    const [bx, by] = xy(rec.to, flip);
    return I.boardBadge(rec.label, bx + .34, by - .34, .28);
  }
  function drawArrows() {
    const b = boardEl(); if (!b) return;
    const s = svgFor(b);
    if (!S.on || allowedHere() !== 'ok' || linesFen !== lastFen) { s.innerHTML = ''; return; }
    const flip = isFlipped(b);
    let h = '', badges = '';
    // chess.com tints the squares of the move that was just graded
    if (S.boardBadge && lastRecord && lastRecord.to) {
      h += I.squareTint(lastRecord.label, xy(lastRecord.to, flip), 1);
      if (lastRecord.from) h += I.squareTint(lastRecord.label, xy(lastRecord.from, flip), 1).replace('opacity=".5"', 'opacity=".28"');
    }
    const n = Math.min(S.moves, lines.length);
    for (let i = n - 1; i >= 0; i--) {   // best move drawn last = on top
      const L = lines[i]; if (!L || !L.pv[0]) continue;
      let op = i === 0 ? .9 : .5;
      if (hoverIdx >= 0) op = i === hoverIdx ? .95 : .12;
      const r = arrow(L.pv[0], flip, i === 0 ? BEST : ALT, i === 0 ? .22 : .14, op, n > 1 ? i + 1 : 0);
      h += r.a; if (hoverIdx < 0 || hoverIdx === i) badges = r.badge + badges;
    }
    if (S.boardBadge && lastRecord && !S.min) badges = badgeMarkup(lastRecord, flip) + badges;
    s.innerHTML = h + badges;
  }

  // ---------- formatting ----------
  function fmtVal(v) {
    if (v === null || v === undefined) return '–';
    if (R.isMate(v)) return (v > 0 ? 'M' : '-M') + R.mateIn(v);
    const p = v / 100;
    return (p > 0 ? '+' : '') + p.toFixed(1);
  }
  function evalOfLine(L) {
    if (!L) return null;
    if (L.mate !== null && L.mate !== undefined) return R.mateScore(L.mate);
    if (L.cp === null || L.cp === undefined) return null;
    return L.cp;
  }
  function fmtLine(L) { return fmtVal(evalOfLine(L)); }
  function barPct(v) {
    if (v === null || v === undefined) return 50;
    if (R.isMate(v)) return v > 0 ? 100 : 0;
    const cp = Math.max(-1500, Math.min(1500, v));
    return Math.max(3, Math.min(97, 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)));
  }
  function verdict(v) {
    if (v === null || v === undefined) return 'Analysing…';
    if (R.isMate(v)) return `${v > 0 ? 'White' : 'Black'} mates in ${R.mateIn(v)}`;
    const a = Math.abs(v), side = v > 0 ? 'White' : 'Black';
    if (a < 35) return 'Equal position';
    if (a < 100) return `${side} is slightly better`;
    if (a < 250) return `${side} is better`;
    if (a < 500) return `${side} is winning`;
    return `${side} is completely winning`;
  }
  function sanFor(L) {
    try {
      const c = new Chess(linesFen); const u = L.pv[0];
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      return m ? m.san : u;
    } catch (e) { return L.pv[0]; }
  }
  function npsText(v) { if (!v) return ''; return v >= 1e6 ? (v / 1e6).toFixed(1) + ' Mn/s' : Math.round(v / 1000) + ' kn/s'; }

  // ---------- panel ----------
  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'bfm-panel';
    panel.innerHTML = `
      <div class="bfm-head">
        <span class="bfm-logo" aria-hidden="true"></span>
        <div class="bfm-brand"><b>Bossfrommars</b><span>LIVE ANALYSIS</span></div>
        <span class="bfm-sp"></span>
        <span class="bfm-live" title="Engine status"><i></i></span>
        <button class="bfm-tg" role="switch" aria-label="Toggle analysis" title="Analysis on/off (Alt+A)"></button>
        <button class="bfm-ib bfm-gear" aria-label="Settings" title="Settings (Alt+S)">⚙</button>
        <button class="bfm-ib bfm-min" aria-label="Minimise panel" title="Minimise (Alt+M)">–</button>
      </div>
      <div class="bfm-body">
        <div class="bfm-evalrow">
          <div class="bfm-score">–</div>
          <div class="bfm-evalmeta">
            <div class="bfm-bar"><div class="bfm-barw"></div></div>
            <div class="bfm-verdict">Waiting for board…</div>
          </div>
        </div>

        <div class="bfm-lastcard" data-q="none">
          <span class="bfm-qi">•</span>
          <div class="bfm-lasttext"><b>Last move</b><small>Play a move to get a label</small></div>
          <span class="bfm-qdelta"></span>
        </div>

        <div class="bfm-turn"></div>
        <div class="bfm-list"></div>
        <div class="bfm-recent"></div>
        <div class="bfm-foot"></div>

        <div class="bfm-set">
          <div class="bfm-setgroup">
            <div class="bfm-setrow"><span>Move labels</span><button class="bfm-sw" data-k="labels" role="switch"></button></div>
            <div class="bfm-setrow"><span>Label pop-up</span><button class="bfm-sw" data-k="popup" role="switch"></button></div>
            <div class="bfm-setrow"><span>Badge on board</span><button class="bfm-sw" data-k="boardBadge" role="switch"></button></div>
            <div class="bfm-setrow"><span>Opening book</span><button class="bfm-sw" data-k="book" role="switch"></button></div>
            <div class="bfm-setrow"><span>Show on every page</span><button class="bfm-sw" data-k="force" role="switch"></button></div>
          </div>
          <div class="bfm-setgroup">
            <label class="bfm-setrow">Eval bar<select data-k="evalbar"><option value="1">Left of board</option><option value="2">Right of board</option><option value="0">Off</option></select></label>
            <label class="bfm-setrow">Arrows shown<select data-k="moves"><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
            <label class="bfm-setrow">Engine depth<select data-k="depth"><option value="14">14 · fast</option><option value="18">18</option><option value="20">20 · normal</option><option value="24">24 · strong</option><option value="99">∞ · infinite</option></select></label>
          </div>
          <div class="bfm-bg-setting">
            <span class="bfm-bg-label">Panel background</span>
            <div class="bfm-bg-actions">
              <label class="bfm-upload">Choose image<input class="bfm-bg-file" type="file" accept="image/*" aria-label="Upload a panel background image"></label>
              <button class="bfm-bg-clear" type="button">Remove</button>
            </div>
            <small>Stays on this device. Dark images work best.</small>
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(panel);
    if (S.x !== null && S.y !== null) { panel.style.left = S.x + 'px'; panel.style.top = S.y + 'px'; panel.style.right = 'auto'; }

    panel.querySelectorAll('select').forEach((sel) => {
      sel.value = String(S[sel.dataset.k]);
      sel.onchange = () => {
        S[sel.dataset.k] = +sel.value; save();
        if (sel.dataset.k !== 'evalbar') { const f = lastFen; lastFen = null; pendingCheck = null; if (f) request(f); }
        renderAll();
      };
    });
    panel.querySelectorAll('.bfm-sw').forEach((sw) => {
      const k = sw.dataset.k;
      sw.onclick = () => {
        S[k] = !S[k]; save(); syncSwitches();
        if (k === 'labels' && !S[k]) { labelsLost = false; pendingCheck = null; }
        renderAll();
      };
    });
    syncSwitches();

    const bgFile = panel.querySelector('.bfm-bg-file');
    bgFile.onchange = () => {
      const file = bgFile.files && bgFile.files[0];
      if (!file) return;
      const note = panel.querySelector('.bfm-bg-setting small');
      if (!file.type.startsWith('image/')) { note.textContent = 'Please choose an image file.'; bgFile.value = ''; return; }
      if (file.size > 20 * 1024 * 1024) { note.textContent = 'That image is too large (max 20 MB).'; bgFile.value = ''; return; }
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
          note.textContent = 'Saved on this device. Dark images work best.';
        } catch (e) { note.textContent = 'Could not use that image. Try another.'; }
        URL.revokeObjectURL(url); bgFile.value = '';
      };
      img.onerror = () => { note.textContent = 'Could not read that image. Try another.'; URL.revokeObjectURL(url); bgFile.value = ''; };
      img.src = url;
    };
    panel.querySelector('.bfm-bg-clear').onclick = () => {
      S.bgImage = ''; save(); applyPanelBackground();
      panel.querySelector('.bfm-bg-setting small').textContent = 'Stays on this device. Dark images work best.';
    };
    applyPanelBackground();

    panel.querySelector('.bfm-tg').onclick = toggle;
    panel.querySelector('.bfm-min').onclick = () => { S.min = !S.min; save(); renderPanel(); };
    panel.querySelector('.bfm-gear').onclick = () => panel.classList.toggle('bfm-showset');

    const list = panel.querySelector('.bfm-list');
    list.addEventListener('mouseover', (e) => { const r = e.target.closest('.bfm-mv'); const i = r ? +r.dataset.i : -1; if (i !== hoverIdx) { hoverIdx = i; drawArrows(); } });
    list.addEventListener('mouseleave', () => { hoverIdx = -1; drawArrows(); });

    const head = panel.querySelector('.bfm-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = panel.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const mv = (ev) => {
        S.x = Math.max(0, Math.min(innerWidth - 80, ev.clientX - ox));
        S.y = Math.max(0, Math.min(innerHeight - 40, ev.clientY - oy));
        panel.style.left = S.x + 'px'; panel.style.top = S.y + 'px'; panel.style.right = 'auto';
      };
      const up = () => { head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); save(); };
      head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up);
    });

    document.addEventListener('keydown', onKey);
    renderPanel();
  }
  function onKey(e) {
    if (!e.altKey) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'a') { toggle(); e.preventDefault(); }
    else if (k === 'm') { S.min = !S.min; save(); renderPanel(); e.preventDefault(); }
    else if (k === 's') { panel.classList.toggle('bfm-showset'); e.preventDefault(); }
  }
  function syncSwitches() {
    if (!panel) return;
    panel.querySelectorAll('.bfm-sw').forEach((sw) => {
      const on = !!S[sw.dataset.k];
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', String(on));
    });
    const tg = panel.querySelector('.bfm-tg');
    tg.classList.toggle('on', !!S.on);
    tg.setAttribute('aria-checked', String(!!S.on));
  }
  function toggle() {
    S.on = !S.on; save();
    if (!S.on) { stop(); hideToast(); }
    syncSwitches(); renderAll();
  }
  function message(icon, title, sub, keepCard) {
    const q = (s) => panel.querySelector(s);
    const sc = q('.bfm-score');
    sc.textContent = icon; sc.className = 'bfm-score muted';
    q('.bfm-barw').style.width = '50%';
    q('.bfm-verdict').textContent = title;
    q('.bfm-turn').textContent = sub || '';
    q('.bfm-list').innerHTML = '';
    q('.bfm-foot').textContent = '';
    if (keepCard && lastRecord) return renderLastCard();
    q('.bfm-lastcard').className = 'bfm-lastcard';
    q('.bfm-lastcard').dataset.q = 'none';
    q('.bfm-lastcard .bfm-qi').textContent = '•';
    q('.bfm-lastcard .bfm-lasttext').innerHTML = '<b>Last move</b><small>Play a move to get a label</small>';
    q('.bfm-lastcard .bfm-qdelta').textContent = '';
    q('.bfm-lastcard .bfm-qdelta').className = 'bfm-qdelta';
  }

  // the "last move" card on its own, so every screen can show it
  function renderLastCard() {
    const card = panel.querySelector('.bfm-lastcard');
    if (!lastRecord) {
      card.className = 'bfm-lastcard'; card.dataset.q = 'none';
      card.querySelector('.bfm-qi').innerHTML = I.disc('none');
      card.querySelector('.bfm-lasttext').innerHTML = '<b>Last move</b><small>' +
        (labelsLost ? 'Reload the page to grade moves from here' : 'Play a move to get a label') + '</small>';
      const d0 = card.querySelector('.bfm-qdelta');
      d0.textContent = ''; d0.className = 'bfm-qdelta';
      return;
    }
    const info = R.info(lastRecord.label);
    card.dataset.q = lastRecord.label;
    card.querySelector('.bfm-qi').innerHTML = I.disc(lastRecord.label);
    card.querySelector('.bfm-lasttext').innerHTML =
      `<b>${info.label || 'Move'} · ${lastRecord.san}</b><small>${info.blurb}</small>`;
    const d = card.querySelector('.bfm-qdelta');
    if (['inaccuracy', 'mistake', 'blunder', 'miss'].indexOf(lastRecord.label) >= 0) {
      d.textContent = '−' + lastRecord.drop.toFixed(0) + '%';
      d.className = 'bfm-qdelta bad';
    } else if (lastRecord.label === 'brilliant' || lastRecord.label === 'great') {
      d.textContent = '★'; d.className = 'bfm-qdelta good';
    } else if (lastRecord.label === 'best' || lastRecord.label === 'excellent') {
      d.textContent = '+'; d.className = 'bfm-qdelta good';
    } else { d.textContent = ''; d.className = 'bfm-qdelta'; }
  }
  function renderPanel() {
    if (!panel) return;
    const here = allowedHere(), b = boardEl();
    panel.classList.toggle('bfm-hidden', here === 'off');
    panel.classList.toggle('bfm-minimised', !!S.min);
    panel.querySelector('.bfm-min').textContent = S.min ? '+' : '–';
    panel.querySelector('.bfm-min').setAttribute('aria-label', S.min ? 'Expand panel' : 'Minimise panel');
    const live = panel.querySelector('.bfm-live');
    live.classList.toggle('thinking', S.on && (state === 'thinking' || state === 'idle'));

    if (here === 'ok' && !b) return message('…', 'Looking for the board…', '', true);
    if (!S.on) return message('Off', 'Analysis is off', 'Click the switch or press Alt+A');
    if (state === 'error') return message('!', 'Engine failed to load', 'Try reloading the page');
    if (state === 'over' && !lines[0]) {
      const turnOver = sideToMove(lastFen || '');
      return message('#', 'Game over', lastRecord && lastRecord.label === 'best' && /#/.test(lastRecord.san) ? 'Checkmate — well played' : 'No moves left in this position', true);
    }

    const fresh = linesFen === lastFen && lines[0];
    if (!fresh) return message('…', lastFen ? (loadingText || 'Thinking…') : 'Waiting for board…', '', true);

    const best = lines[0];
    const bestCp = evalOfLine(best);
    const sc = panel.querySelector('.bfm-score');
    sc.textContent = fmtLine(best);
    sc.className = 'bfm-score' + (bestCp !== null && bestCp < 0 ? ' neg' : '');
    panel.querySelector('.bfm-barw').style.width = barPct(bestCp) + '%';
    panel.querySelector('.bfm-verdict').textContent = verdict(bestCp);

    // last move card
    renderLastCard();

    const turn = sideToMove(linesFen);
    panel.querySelector('.bfm-turn').innerHTML =
      `<span class="bfm-pawn ${turn}"></span><span>${turn === 'w' ? 'White' : 'Black'} to move</span>` +
      `<span class="bfm-topn">top ${Math.min(S.moves, lines.filter(Boolean).length)}</span>`;

    let h = '';
    for (let i = 0; i < S.moves; i++) {
      const M = lines[i];
      if (!M || !M.pv[0]) { h += `<div class="bfm-mv empty"><span class="bfm-num">${i + 1}</span><b>…</b></div>`; continue; }
      const v = evalOfLine(M);
      h += `<div class="bfm-mv${i === 0 ? ' top' : ''}" data-i="${i}">
        <span class="bfm-num">${i + 1}</span>
        <b>${sanFor(M)}</b>
        <span class="bfm-pv">${pvText(M)}</span>
        <span class="bfm-e${v !== null && v < 0 ? ' neg' : ''}">${fmtVal(v)}</span>
      </div>`;
    }
    panel.querySelector('.bfm-list').innerHTML = h;

    // recent labelled moves
    const recent = moveLog.slice(-10);
    panel.querySelector('.bfm-recent').innerHTML = recent.length
      ? recent.map((r) => {
        const num = r.moveNo + (r.color === 'w' ? '.' : '…');
        return `<span class="bfm-rm" data-q="${r.label}" title="${R.info(r.label).label}"><i>${num}</i>${r.san}${I.svg(r.label, 'bfm-rmi')}</span>`;
      }).join('')
      : '';

    panel.querySelector('.bfm-foot').innerHTML =
      `<span class="bfm-dot"></span>${engineName || 'Stockfish 19'} · depth ${best.depth}` +
      (nps ? ` · ${npsText(nps)}` : '') + (state === 'done' ? ' · ready' : ' · thinking');
  }
  function pvText(M) {
    // a short continuation, rendered in a tiny monospace line
    const pv = (M.pv || []).slice(1, 4);
    if (!pv.length) return '';
    try {
      const c = new Chess(linesFen);
      c.move({ from: M.pv[0].slice(0, 2), to: M.pv[0].slice(2, 4), promotion: M.pv[0][4] });
      const out = [];
      for (const u of pv) {
        const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        if (!m) break;
        out.push(m.san);
      }
      return out.join(' ');
    } catch (e) { return ''; }
  }

  // ---------- pop-up ----------
  function ensureToast() {
    if (toastEl) return toastEl;
    toastEl = document.createElement('div');
    toastEl.className = 'bfm-toast';
    toastEl.innerHTML = '<span class="bfm-ti"></span><div class="bfm-tt"><b></b><small></small></div>';
    document.documentElement.appendChild(toastEl);
    return toastEl;
  }
  function showToast(rec) {
    const info = R.info(rec.label);
    if (!info.label) { hideToast(); return; }
    const el = ensureToast();
    el.dataset.q = rec.label;
    el.querySelector('.bfm-ti').innerHTML = I.disc(rec.label);
    el.querySelector('.bfm-tt b').textContent = info.label;
    el.querySelector('.bfm-tt small').textContent = rec.san + ' — ' + info.blurb;
    positionToast();
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 3800);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.classList.remove('show');
  }
  function positionToast() {
    if (!toastEl) return;
    const b = boardEl();
    if (!b) { toastEl.style.left = ''; toastEl.style.top = ''; toastEl.style.bottom = '24px'; return; }
    const r = b.getBoundingClientRect();
    const w = 260;
    toastEl.style.left = Math.max(12, r.left + r.width / 2 - w / 2) + 'px';
    toastEl.style.top = (r.top + r.height - 74) + 'px';
    toastEl.style.bottom = 'auto';
  }

  // ---------- eval bar ----------
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
    const w = Math.max(15, Math.round(r.width * 0.036)), gap = 7;
    Object.assign(bar.style, {
      display: 'block', width: w + 'px', height: r.height + 'px', top: r.top + 'px',
      left: (S.evalbar === 2 ? r.right + gap : r.left - gap - w) + 'px'
    });
    const flip = isFlipped(b);
    bar.classList.toggle('flip', flip);
    let pct = 50, txt = '', whiteAhead = true;
    if (fresh) {
      const v = evalOfLine(lines[0]);
      pct = barPct(v);
      whiteAhead = v === null ? true : v >= 0;
      txt = v === null ? '' : (R.isMate(v) ? 'M' + R.mateIn(v) : Math.abs(v / 100).toFixed(1));
    } else if (state === 'over') {
      try {
        const c = new Chess(lastFen);
        if (c.in_checkmate()) { whiteAhead = c.turn() === 'b'; pct = whiteAhead ? 100 : 0; txt = whiteAhead ? '1-0' : '0-1'; }
        else txt = '½';
      } catch (e) {}
    }
    bar.querySelector('.bfm-eb-w').style.height = pct + '%';
    const l = bar.querySelector('.bfm-eb-l');
    l.textContent = txt;
    const atBottom = whiteAhead !== flip;
    l.className = 'bfm-eb-l ' + (atBottom ? 'bot' : 'top') + (whiteAhead ? ' onw' : ' onb');
    l.style.fontSize = Math.max(9, Math.round(w * 0.42)) + 'px';
  }
  addEventListener('scroll', () => { renderBar(); positionToast(); }, { passive: true, capture: true });
  addEventListener('resize', () => { renderBar(); positionToast(); });

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
    let fen = currentFen(b);
    if (!fen) { renderAll(); return; }

    if (!lastFen) {
      lastFen = fen; linesFen = fen; visit(fen, null);
      if (gameOverFen(fen)) { lines = []; state = 'over'; pendingCheck = null; }
      else request(fen);
      renderAll(); return;
    }

    if (fen === lastFen) { visit(fen, fen); drawArrows(); renderBar(); return; }

    // ---- the position changed ----
    if (samePos(fen, lastFen)) {
      // only the side to move / counters differ: same position, refresh quietly
      lastFen = fen; linesFen = fen; visit(fen, fen);
      request(fen); return;
    }

    if (gameOverFen(fen)) {
      const prevFen = lastFen, prevLines = lines.slice();
      stop();
      lastFen = fen; lines = []; linesFen = fen; state = 'over';
      visit(fen, prevFen);
      noteTransition(prevFen, prevLines, fen);
      finalizeMate();
      renderAll();
      return;
    }

    // a normal move (or a rewind) — the previous search becomes the reference
    const prevFen = lastFen, prevLines = lines.slice();
    noteTransition(prevFen, prevLines, fen);
    visit(fen, prevFen);
    request(fen);
    renderAll();
  }
  setInterval(tick, 280);
})();
