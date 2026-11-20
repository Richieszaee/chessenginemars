// Bossfrommars — live move classification (chess.com style labels).
// window.BFMReview. All evals are centipawns from WHITE's point of view.
(function () {
  const MATE = 100000;
  const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  // ---------- eval helpers ----------
  function mateScore(mate) {
    if (mate === null || mate === undefined) return null;
    return mate > 0 ? MATE - mate * 100 : -MATE - mate * 100;
  }
  // engine output is already white-POV in this extension; keep a helper anyway
  function normalizeEval(cp, mate, turn) {
    let v;
    if (mate !== null && mate !== undefined) v = mateScore(mate);
    else if (cp === null || cp === undefined) return null;
    else v = cp;
    return turn === 'b' ? -v : v;
  }
  function evalOf(line) {
    if (!line) return null;
    if (line.mate !== null && line.mate !== undefined) return mateScore(line.mate);
    if (line.cp === null || line.cp === undefined) return null;
    return line.cp;
  }
  function isMate(v) { return v !== null && v !== undefined && Math.abs(v) >= MATE - 1000; }
  function mateIn(v) { return isMate(v) ? Math.round((MATE - Math.abs(v)) / 100) : null; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // win probability curve (0..1), the same shape chess.com's eval bar uses
  function winProb(v) {
    if (v === null || v === undefined) return 0.5;
    if (isMate(v)) return v > 0 ? 1 : 0;
    const cp = clamp(v, -1500, 1500);
    return 0.5 + 0.5 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }

  // ---------- labels ----------
  const INFO = {
    brilliant: { key: 'brilliant', label: 'Brilliant', color: '#1bb8ad', glyph: '!!', blurb: 'A stunning sacrifice that works' },
    great: { key: 'great', label: 'Great move', color: '#5a8ddd', glyph: '!', blurb: 'The only move that keeps the advantage' },
    best: { key: 'best', label: 'Best move', color: '#81b64c', glyph: '★', blurb: 'The engine’s first choice' },
    excellent: { key: 'excellent', label: 'Excellent', color: '#95bb4a', glyph: '✓', blurb: 'Almost as good as the best move' },
    good: { key: 'good', label: 'Good', color: '#a5b83f', glyph: '✓', blurb: 'A solid move' },
    book: { key: 'book', label: 'Book', color: '#b08d62', glyph: '❖', blurb: 'Known opening theory' },
    inaccuracy: { key: 'inaccuracy', label: 'Inaccuracy', color: '#f0c23c', glyph: '?!', blurb: 'A better move was available' },
    mistake: { key: 'mistake', label: 'Mistake', color: '#e8963c', glyph: '?', blurb: 'This lets the advantage slip' },
    blunder: { key: 'blunder', label: 'Blunder', color: '#e05b50', glyph: '??', blurb: 'A serious error' },
    miss: { key: 'miss', label: 'Miss', color: '#e8663c', glyph: '⨯', blurb: 'A winning chance was missed' },
    forced: { key: 'forced', label: 'Forced', color: '#8797a4', glyph: '→', blurb: 'The only legal move' },
    none: { key: 'none', label: '', color: '#8797a4', glyph: '', blurb: '' }
  };
  function info(k) { return INFO[k] || INFO.none; }
  function suffix(k) { const g = info(k).glyph; return g === '✓' || g === '→' ? '' : g; }

  // ---------- opening book (prefixes of popular theory) ----------
  const BOOK = [
    'e4 e5 Nf3 Nc6 Bb5 a6', 'e4 e5 Nf3 Nc6 Bc4', 'e4 e5 Nf3 Nc6 d4', 'e4 e5 Nf3 Nf6',
    'e4 e5 Nf3 d6', 'e4 e5 Bc4', 'e4 e5 Nc3', 'e4 e5 f4',
    'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', 'e4 c5 Nf3 Nc6 d4', 'e4 c5 Nc3', 'e4 c5 c3', 'e4 c5 Nf3 e6',
    'e4 e6 d4 d5', 'e4 c6 d4 d5', 'e4 d5', 'e4 d6 d4 Nf6', 'e4 Nf6', 'e4 g6', 'e4 d6',
    'e4 c5', 'e4 e5', 'e4 e6', 'e4 c6', 'e4 d5', 'e4 d6', 'e4 g6', 'e4 Nf6', 'e4 c5',
    'd4 d5 c4 e6 Nc3 Nf6', 'd4 d5 c4 c6', 'd4 d5 c4 dxc4', 'd4 d5 c4 e6', 'd4 d5 c4',
    'd4 Nf6 c4 e6 Nc3 Bb4', 'd4 Nf6 c4 g6 Nc3 Bg7', 'd4 Nf6 c4 e6 Nc3 d5', 'd4 Nf6 c4 g6',
    'd4 Nf6 c4 c5', 'd4 Nf6 c4 e6', 'd4 Nf6 c4 g6', 'd4 Nf6 c4', 'd4 Nf6 Nf3',
    'd4 d5 Nf3', 'd4 d5 c4', 'd4 d5', 'd4 Nf6', 'd4 f5', 'd4 g6', 'd4 e6', 'd4 c5',
    'c4 e5', 'c4 Nf6', 'c4 e6', 'c4 c5', 'Nf3 d5', 'Nf3 Nf6', 'g3 d5', 'b3 e5', 'f4 d5', 'b4 e5',
    'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4', 'e4 e5 Nf3 Nc6 Bb5 Nf6', 'e4 e5 Nf3 Nc6 Bb5 Bc5',
    'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6'
  ];
  const BOOK_SET = BOOK.map((l) => l.trim().split(/\s+/));
  function isBook(seq) {
    if (!seq || !seq.length || seq.length > 16) return false;
    for (const line of BOOK_SET) {
      if (line.length < seq.length) continue;
      let ok = true;
      for (let i = 0; i < seq.length; i++) if (line[i] !== seq[i]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }

  // ---------- position helpers ----------
  function attackersOf(c, sq, color) {
    const out = [];
    try {
      for (const m of c.moves({ verbose: true })) if (m.to === sq && m.color === color) out.push(m);
    } catch (e) {}
    return out;
  }

  /**
   * Facts about a played move that pure eval numbers cannot see.
   * fen      position before the move
   * move     chess.js verbose move, with .before / .after added by the caller
   * bestUci  engine best move in that position (or null)
   */
  function facts(fen, move, bestUci, secondBestGap) {
    const out = { sacrifice: false, onlyMove: false, onlyGood: false, punish: false, give: 0, take: 0, legal: 0 };
    if (!fen || !move) return out;
    let before, opp;
    try {
      before = new window.BFMChess(fen);
      opp = new window.BFMChess(move.after);
    } catch (e) { return out; }

    const us = move.color;
    const them = us === 'w' ? 'b' : 'w';

    try { out.legal = before.moves().length; } catch (e) {}
    out.onlyMove = out.legal === 1;
    // "only good move": alternatives lose a big chunk of the position
    out.onlyGood = !!(secondBestGap !== null && secondBestGap !== undefined && secondBestGap >= 12);

    // biggest capture that was available (context only)
    try {
      for (const m of before.moves({ verbose: true })) {
        const cap = m.flags.indexOf('c') >= 0 || m.flags.indexOf('e') >= 0;
        if (!cap) continue;
        const victim = m.flags.indexOf('e') >= 0 ? { type: 'p' } : before.get(m.to);
        if (victim && victim.color !== us) out.give = Math.max(out.give, VAL[victim.type] || 0);
      }
      const taken = move.flags.indexOf('c') >= 0 || move.flags.indexOf('e') >= 0;
      if (taken) {
        const victim = move.flags.indexOf('e') >= 0 ? { type: 'p' } : before.get(move.to);
        out.take = victim ? (VAL[victim.type] || 0) : 0;
      }
    } catch (e) {}

    // sacrifice: the piece we just moved can be taken by something cheaper, and
    // what we got back for it is clearly worth less
    try {
      const myVal = VAL[move.piece] || 0;
      if (myVal >= 2 && move.to) {
        let cheapest = 99;
        for (const m of attackersOf(opp, move.to, them)) {
          cheapest = Math.min(cheapest, VAL[m.piece] || 1);
        }
        // pieces only need to be offered for less than they are worth; pawn
        // "sacrifices" need a real chunk of material behind them
        const need = move.piece === 'p' ? 2 : 1;
        if (cheapest < 99 && myVal - cheapest - out.take >= need) out.sacrifice = true;
      }
    } catch (e) {}

    // punish: we captured something the opponent left undefended
    try {
      if (out.take >= 1) {
        const recapture = attackersOf(opp, move.to, them).filter((m) => m.to === move.to);
        if (!recapture.length) out.punish = true;
      }
    } catch (e) {}
    return out;
  }

  /**
   * The main classifier.
   * d = { fen, playedUci, bestUci, bestCp, secondCp, playedCp, book, facts, mateAfter }
   */
  function classify(d) {
    const turn = (d.fen.split(' ')[1] || 'w');
    const F = d.facts || {};
    if (d.forced || F.onlyMove) return 'forced';
    if (d.book) return 'book';

    const best = d.bestCp === undefined ? null : d.bestCp;
    const played = d.playedCp === undefined ? null : d.playedCp;
    const isBest = !!(d.bestUci && d.playedUci && d.bestUci.slice(0, 4) === d.playedUci.slice(0, 4) &&
      (d.bestUci.length < 5 || d.bestUci[4] === (d.playedUci[4] || '')));

    const sign = turn === 'w' ? 1 : -1;
    const wpFor = (v) => { const w = winProb(v); return sign === 1 ? w : 1 - w; };
    const before = wpFor(best);
    const after = wpFor(played);
    const drop = clamp((before - after) * 100, 0, 100);

    // a move that ends the game on the spot is always the best move
    if (d.mateAfter) return 'best';

    if (isBest) {
      // brilliant: a genuine sacrifice that still holds up
      if (F.sacrifice && before >= 0.5) return 'brilliant';
      // great: the only move that works, or a tactical punish
      if (F.onlyGood || F.punish || (F.onlyMove && before >= 0.5)) return 'great';
      return 'best';
    }

    if (drop <= 2) return 'excellent';
    if (drop <= 5) return 'good';
    if (drop <= 10) return 'inaccuracy';
    if (drop <= 21) return 'mistake';
    // a genuinely winning position was thrown away in one move
    if (before >= 0.78 && after <= 0.62 && drop >= 18) return 'miss';
    return 'blunder';
  }

  function material(c, color) {
    let s = 0;
    try { for (const row of c.board()) for (const p of row) if (p && p.color === color) s += VAL[p.type] || 0; } catch (e) {}
    return s;
  }

  window.BFMReview = {
    MATE, mateScore, normalizeEval, evalOf, isMate, mateIn, winProb, clamp,
    classify, facts, info, suffix, isBook, material, INFO
  };
})();
