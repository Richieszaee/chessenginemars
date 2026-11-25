// Bossfrommars — board drawing helpers.
// Arrows are drawn as filled shapes (a tapered shaft plus a solid head) rather
// than a stroked polyline with a glued-on triangle, and every corner is
// rounded, so they stay smooth and even at any board size — including the
// knight's elbow.
(function () {
  const P = (v) => Number(v).toFixed(3);

  function unit(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len, len];
  }

  // four corners of a rectangle running from (x1,y1) to (x2,y2)
  function band(x1, y1, x2, y2, ux, uy, w) {
    const nx = -uy * w / 2, ny = ux * w / 2;
    return [
      [x1 + nx, y1 + ny], [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]
    ];
  }

  function poly(pts, color, extra) {
    return '<polygon points="' + pts.map((q) => P(q[0]) + ',' + P(q[1])).join(' ') +
      '" fill="' + color + '" stroke="' + color + '" stroke-width="' + (extra || .018) +
      '" stroke-linejoin="round"/>';
  }

  /**
   * Geometry of a chess.com-style arrow, in board units (1 = one square).
   *   width  shaft thickness   headW  head width   headL  head length
   */
  function arrowPath(ax, ay, bx, by, opts) {
    const o = opts || {};
    const [, , len] = unit(ax, ay, bx, by);
    const width = o.width || .16;
    const headW = o.headW || .42;
    const headL = Math.min(o.headL || .4, len * .6);

    // knight move: run along the longer axis first, then turn in
    let mx = bx, my = by;
    if (o.knight) {
      mx = Math.abs(bx - ax) >= Math.abs(by - ay) ? bx : ax;
      my = mx === bx ? ay : by;
    }
    const bend = Math.abs(mx - bx) > 1e-6 || Math.abs(my - by) > 1e-6;

    const [ux1, uy1] = unit(ax, ay, mx, my);
    const [hx, hy] = bend ? unit(mx, my, bx, by) : [ux1, uy1];
    // where the head begins — kept inside the shaft so the two never gap
    const baseX = bx - hx * headL, baseY = by - hy * headL;

    const tail = .16;                       // start just inside the square
    const sx = ax + ux1 * tail, sy = ay + uy1 * tail;
    const shaft = band(sx, sy, baseX + hx * .04, baseY + hy * .04, hx, hy, width);

    const nx = -hy, ny = hx;
    const head = [
      [bx, by],
      [baseX + nx * headW / 2, baseY + ny * headW / 2],
      [baseX - nx * headW / 2, baseY - ny * headW / 2]
    ];
    return { shaft, head, bend, mx, my, ux1, uy1, hx, hy, headL, width };
  }

  /** full <g> for one arrow */
  function arrow(ax, ay, bx, by, color, opts) {
    const o = opts || {};
    const g = arrowPath(ax, ay, bx, by, o);
    const op = o.opacity === undefined ? .82 : o.opacity;
    let out = '';
    if (g.bend) {
      // elbow: two bands meeting at the corner, rounded by the stroke join
      out += poly(band(
        ax + g.ux1 * .16, ay + g.uy1 * .16, g.mx, g.my, g.ux1, g.uy1, g.width), color);
      out += poly(band(
        g.mx, g.my, bx - g.hx * g.headL * .55, by - g.hy * g.headL * .55, g.hx, g.hy, g.width), color);
    } else {
      out += poly(g.shaft, color);
    }
    out += poly(g.head, color, .02);
    return '<g opacity="' + op + '">' + out + '</g>';
  }

  /** numbered disc that sits on the arrow head, like chess.com's 1 / 2 / 3 */
  function numberDisc(cx, cy, r, n, color) {
    return '<g class="bfm-arrow-num">' +
      '<circle cx="' + P(cx) + '" cy="' + P(cy) + '" r="' + r + '" fill="' + color + '"/>' +
      '<text x="' + P(cx) + '" y="' + P(cy + r * .35) + '" text-anchor="middle" ' +
      'font-family="Arial,Helvetica,sans-serif" font-size="' + P(r * 1.28) + '" font-weight="700" ' +
      'fill="#fff">' + n + '</text></g>';
  }

  window.BFMDraw = { arrowPath, arrow, numberDisc, unit, poly };
})();
