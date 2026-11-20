// Bossfrommars — move-classification icons.
// Chess.com's exact palette + shapes: a coloured disc with a white glyph
// (star, thumb, check, !!, !, ?, ?!, ??, x, book, arrow).
(function () {
  // chess.com colours, taken from their game-review palette
  const COLOR = {
    brilliant: '#26c2a3',
    great: '#5c8bb0',
    best: '#96bc4b',
    excellent: '#81b64c',
    good: '#95af8b',
    book: '#a88865',
    inaccuracy: '#f7c631',
    mistake: '#ffa459',
    miss: '#ff7769',
    blunder: '#ca3431',
    forced: '#b0b0b0',
    none: '#7d8d9a'
  };

  const FONT = 'Arial,Helvetica,sans-serif';

  // two punctuation marks side by side, centred in the 24x24 box
  function punct(a, b, x1, x2, size) {
    return '<text x="' + x1 + '" y="17.6" text-anchor="middle" font-family="' + FONT +
      '" font-size="' + size + '" font-weight="900">' + a + '</text>' +
      '<text x="' + x2 + '" y="17.6" text-anchor="middle" font-family="' + FONT +
      '" font-size="' + size + '" font-weight="900">' + b + '</text>';
  }

  // every shape is drawn in a 24x24 box and paints with currentColor
  const SHAPES = {
    // ★ best
    best: '<path d="M12 2.6l2.95 6.1 6.7.95-4.88 4.72 1.2 6.63L12 17.85l-5.97 3.15 1.2-6.63L2.35 9.65l6.7-.95z"/>',
    // thumbs up — excellent
    excellent: '<path d="M4 11.4h2.9c.55 0 1 .45 1 1v7.9c0 .55-.45 1-1 1H4z"/>' +
               '<path d="M9.3 21.3V11.6l3.5-5.9a1.9 1.9 0 0 1 3.3 1.05v2.35h3.2a2.2 2.2 0 0 1 2.15 2.7l-1.15 5.9a2.2 2.2 0 0 1-2.15 1.8z"/>',
    // ✓ good
    good: '<path d="M4.6 12.4l4.5 4.6L19.4 6.6" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>',
    // !!  (two marks, spaced like chess.com)
    brilliant: punct('!', '!', 7.6, 16.4, 14),
    // !
    great: '<text x="12" y="17.3" text-anchor="middle" font-family="' + FONT + '" font-size="15.5" font-weight="900">!</text>',
    // ?!
    inaccuracy: punct('?', '!', 7.6, 16.4, 13.4),
    // ?
    mistake: '<text x="12" y="17.3" text-anchor="middle" font-family="' + FONT + '" font-size="15.5" font-weight="900">?</text>',
    // ??
    blunder: punct('?', '?', 7.6, 16.4, 14),
    // ✗ miss
    miss: '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round"/>',
    // book
    book: '<path d="M3.6 5.1c2.7-1.05 5.4-1 8.4.7 3-1.7 5.7-1.75 8.4-.7v13.3c-2.7-1.05-5.4-1-8.4.7-3-1.7-5.7-1.75-8.4-.7z"/>' +
          '<path d="M12 5.8v13" fill="none" stroke="#000" stroke-opacity=".28" stroke-width="1.3"/>',
    // →
    forced: '<path d="M4.6 12h12.2M12.6 7.4L17.4 12l-4.8 4.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
    none: '<circle cx="12" cy="12" r="4.2"/>'
  };

  function color(key) { return COLOR[key] || COLOR.none; }
  function shapes(key) { return SHAPES[key] || SHAPES.none; }

  // raw <svg> for inline use (fill = currentColor, so CSS can colour it)
  function svg(key, cls) {
    return '<svg class="bfm-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" ' +
      'fill="currentColor" aria-hidden="true">' + shapes(key) + '</svg>';
  }

  // chess.com style circular badge: coloured disc, white glyph
  function disc(key, cls) {
    return '<span class="bfm-disc' + (cls ? ' ' + cls : '') + '" data-q="' + key + '" ' +
      'style="--q:' + color(key) + '">' + svg(key) + '</span>';
  }

  // the same badge, drawn inside the board's own <svg> (units are board squares)
  function boardBadge(key, cx, cy, r) {
    const c = color(key);
    const inner = r * 1.16;               // glyph box inside the disc
    const ox = cx - inner / 2, oy = cy - inner / 2;
    return '<g class="bfm-badge-mark">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + c + '" stroke="rgba(0,0,0,.35)" stroke-width="' + (r * 0.07) + '"/>' +
      '<svg x="' + ox + '" y="' + oy + '" width="' + inner + '" height="' + inner + '" viewBox="0 0 24 24" fill="#fff" color="#fff">' +
      shapes(key) + '</svg></g>';
  }

  // chess.com tints the destination square (and lightly the origin) of a graded move
  function squareTint(key, xy, size) {
    return '<rect x="' + xy[0] + '" y="' + xy[1] + '" width="' + size + '" height="' + size +
      '" fill="' + color(key) + '" opacity=".5"/>';
  }

  window.BFMIcons = { COLOR, color, shapes, svg, disc, boardBadge, squareTint };
})();
