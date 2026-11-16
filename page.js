// Runs in the page's own JS world so it can read Chess.com's board object directly.
(function () {
  let lastFen = null;
  function read() {
    const el = document.querySelector('wc-chess-board, chess-board');
    let fen = null, over = false, flipped = null, variant = null, pgn;
    if (el && el.game) {
      const g = el.game;
      try { if (typeof g.getFEN === 'function') fen = g.getFEN(); } catch (e) {}
      try { if (typeof g.isGameOver === 'function') over = !!g.isGameOver(); } catch (e) {}
      try {
        const o = g.getOptions && g.getOptions();
        if (o) {
          if (typeof o.flipped === 'boolean') flipped = o.flipped;
          if (typeof o.variant === 'string') variant = o.variant;
        }
      } catch (e) {}
      if (fen && fen !== lastFen) {
        lastFen = fen;
        pgn = null;
        try { if (typeof g.getPGN === 'function') pgn = g.getPGN(); } catch (e) {}
      }
    }
    window.postMessage({ __bfm: 'pos', fen, over, flipped, variant, pgn }, '*');
  }
  setInterval(read, 250);
  read();
})();
