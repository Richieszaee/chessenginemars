const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

global.window = global;
require(path.join(__dirname, '..', 'chess.js'));

const off = require(path.join(__dirname, '..', 'offscreen.js'));
const content = require(path.join(__dirname, '..', 'content.js'));

test('offscreen: resolveEngineKey respects cross-origin isolation and fallback', () => {
  assert.equal(off.resolveEngineKey('sf18-nnue', true), 'sf18-nnue');
  assert.equal(off.resolveEngineKey('lite-mt', true), 'lite-mt');
  assert.equal(off.resolveEngineKey('lite', true), 'lite');
  assert.equal(off.resolveEngineKey('unknown', true), 'sf18-nnue');

  assert.equal(off.resolveEngineKey('sf18-nnue', false), 'lite');
  assert.equal(off.resolveEngineKey('lite-mt', false), 'lite');
  assert.equal(off.resolveEngineKey('lite', false), 'lite');
});

test('offscreen: resolveThreads and resolveHash compute optimal values', () => {
  const nnue = off.ENGINES['sf18-nnue'];
  const lite = off.ENGINES.lite;

  assert.equal(off.resolveThreads(0, nnue, 8), 7);
  assert.equal(off.resolveThreads(0, nnue, 4), 3);
  assert.equal(off.resolveThreads(0, nnue, 2), 2);
  assert.equal(off.resolveThreads(0, nnue, 24), 16);
  assert.equal(off.resolveThreads(4, nnue, 8), 4);
  assert.equal(off.resolveThreads(8, lite, 8), 1);

  assert.equal(off.resolveHash(0, nnue), 128);
  assert.equal(off.resolveHash(0, lite), 64);
  assert.equal(off.resolveHash(256, nnue), 256);
  assert.equal(off.resolveHash(4, nnue), 128);
});

test('offscreen: parseInfoLine handles WDL, mate, bounds, and Black-to-move flipping', () => {
  const lineW = 'info depth 18 seldepth 26 multipv 1 score cp 45 wdl 120 850 30 nodes 123456 nps 500000 hashfull 42 time 240 pv e2e4 e7e5 g1f3';
  const pw = off.parseInfoLine(lineW, 'w');
  assert.equal(pw.depth, 18);
  assert.equal(pw.seldepth, 26);
  assert.equal(pw.mpv, 1);
  assert.equal(pw.cp, 45);
  assert.equal(pw.mate, null);
  assert.deepEqual(pw.wdl, [120, 850, 30]);
  assert.equal(pw.nps, 500000);
  assert.deepEqual(pw.pv, ['e2e4', 'e7e5', 'g1f3']);

  const pb = off.parseInfoLine(lineW, 'b');
  assert.equal(pb.cp, -45);
  assert.deepEqual(pb.wdl, [30, 850, 120]);

  const mateLine = 'info depth 12 multipv 1 score mate 3 nodes 1000 nps 10000 pv d1h5';
  assert.equal(off.parseInfoLine(mateLine, 'w').mate, 3);
  assert.equal(off.parseInfoLine(mateLine, 'b').mate, -3);

  const boundLine = 'info depth 14 multipv 1 score cp 80 lowerbound nodes 100 nps 100 pv e2e4';
  assert.equal(off.parseInfoLine(boundLine, 'w'), null);
});

test('offscreen: buildPositionCommand includes move history when available', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.equal(
    off.buildPositionCommand({ fen: 'curfen', startFen: start, moves: ['e2e4', 'e7e5'] }),
    `position fen ${start} moves e2e4 e7e5`
  );
  assert.equal(
    off.buildPositionCommand({ fen: 'curfen', startFen: start, moves: [] }),
    'position fen curfen'
  );
});

test('content: HistoryTracker tracks moves, backward navigation, PGNs, and new games', () => {
  const Chess = globalThis.BFMChess;
  const tracker = new content.HistoryTracker(Chess);
  const c = new Chess();

  const f0 = c.fen();
  const r0 = tracker.resolve(f0, null);
  assert.equal(r0.newGame, true);
  assert.deepEqual(r0.moves, []);

  c.move('e4');
  const f1 = c.fen().replace(' e3 ', ' - ');
  const r1 = tracker.resolve(f1, null);
  assert.equal(r1.newGame, false);
  assert.deepEqual(r1.moves, ['e2e4']);

  c.move('e5');
  const f2 = c.fen().replace(' e6 ', ' - ');
  const r2 = tracker.resolve(f2, null);
  assert.equal(r2.newGame, false);
  assert.deepEqual(r2.moves, ['e2e4', 'e7e5']);

  const rBack = tracker.resolve(f1, null);
  assert.equal(rBack.newGame, false);
  assert.deepEqual(rBack.moves, ['e2e4']);

  const pgn = '1. d4 {[%clk 0:10:00]} 1... d5 2. c4 e6';
  const c2 = new Chess();
  c2.move('d4');
  c2.move('d5');
  const rPgn = tracker.resolve(c2.fen(), pgn);
  assert.equal(rPgn.newGame, true);
  assert.deepEqual(rPgn.moves, ['d2d4', 'd7d5']);
});

test('content: AnalysisCache stores, retrieves, updates LRU order, and evicts oldest', () => {
  const cache = new content.AnalysisCache(2);
  cache.set('f1', 'sf18-nnue', 4, 20, [{ cp: 30, pv: ['e2e4'], wdl: [100, 800, 100] }], { engine: 'SF 18 NNUE' });
  cache.set('f2', 'sf18-nnue', 4, 20, [{ cp: -20, pv: ['d2d4'] }], { engine: 'SF 18 NNUE' });
  assert.equal(cache.get('f1', 'sf18-nnue', 4).depth, 20);
  cache.set('f3', 'sf18-nnue', 4, 22, [{ cp: 0, pv: ['c2c4'] }], { engine: 'SF 18 NNUE' });

  assert.equal(cache.get('f2', 'sf18-nnue', 4), null);
  assert.equal(cache.get('f1', 'sf18-nnue', 4).lines[0].cp, 30);
  assert.equal(cache.get('f3', 'sf18-nnue', 4).depth, 22);
});

test('content: moveQuality uses expected score & mate precedence accurately', () => {
  const bestWin = { cp: 800, mate: null, wdl: [980, 19, 1] };
  const stillWin = { cp: 700, mate: null, wdl: [970, 28, 2] };
  assert.equal(content.moveQuality(1, bestWin, stillWin, 'w')[0], 'Excellent');

  const bestEq = { cp: 30, mate: null, wdl: [120, 820, 60] };
  const blunder = { cp: -300, mate: null, wdl: [10, 120, 870] };
  assert.equal(content.moveQuality(1, bestEq, blunder, 'w')[0], 'Blunder');

  const bestMate = { cp: null, mate: 2 };
  const missedMate = { cp: 150, mate: null };
  assert.equal(content.moveQuality(1, bestMate, missedMate, 'w')[0], 'Missed win');
  assert.ok(content.cpWhite(bestMate) > content.cpWhite({ cp: 15000, mate: null }));
});

test('content: pvToSan converts UCI PV to SAN', () => {
  const Chess = globalThis.BFMChess;
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.deepEqual(
    content.pvToSan(Chess, start, ['e2e4', 'c7c5', 'g1f3', 'd7d6'], 4),
    ['e4', 'c5', 'Nf3', 'd6']
  );
});

function runCliEngine(engineFile, { threads = 1, positionCmd, depth = 10 }) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [engineFile], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const lines = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { p.kill(); } catch (e) {}
        reject(new Error(`Timeout running ${engineFile}`));
      }
    }, 20000);

    p.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const raw of parts) {
        const l = raw.trim();
        if (!l) continue;
        lines.push(l);
        if (l === 'uciok') {
          if (threads > 1) p.stdin.write(`setoption name Threads value ${threads}\n`);
          p.stdin.write('setoption name Hash value 64\n');
          p.stdin.write('setoption name UCI_ShowWDL value true\n');
          p.stdin.write('setoption name MultiPV value 2\n');
          p.stdin.write('isready\n');
        } else if (l === 'readyok') {
          p.stdin.write('ucinewgame\n');
          p.stdin.write(positionCmd + '\n');
          p.stdin.write(`go depth ${depth}\n`);
        } else if (l.startsWith('bestmove')) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { p.stdin.write('quit\n'); p.kill(); } catch (e) {}
            resolve({ bestmove: l.split(' ')[1], lines });
          }
        }
      }
    });
    p.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    p.stdin.write('uci\n');
  });
}

test('integration: Stockfish 18 NNUE multi-threaded searches with WDL & move history', async () => {
  const res = await runCliEngine(path.join(__dirname, '..', 'stockfish-18-lite.js'), {
    threads: 2,
    positionCmd: 'position startpos moves g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1',
    depth: 12
  });
  assert.ok(res.bestmove && res.bestmove.length >= 4);
  const wdlInfo = res.lines.find((l) => l.includes(' wdl ') && l.includes(' multipv 1 ') && l.includes(' pv '));
  assert.ok(wdlInfo, 'Stockfish 18 NNUE should emit WDL info lines');
  const parsed = off.parseInfoLine(wdlInfo, 'b');
  assert.ok(parsed && Array.isArray(parsed.wdl) && parsed.wdl.length === 3);
});

test('integration: Stockfish 19 Lite multi-threaded and single-threaded both respond cleanly', async () => {
  const mt = await runCliEngine(path.join(__dirname, '..', 'stockfish-19-lite.js'), {
    threads: 2,
    positionCmd: 'position startpos',
    depth: 10
  });
  assert.ok(mt.bestmove && mt.bestmove.length >= 4);

  const single = await runCliEngine(path.join(__dirname, '..', 'stockfish-19-lite-single.js'), {
    threads: 1,
    positionCmd: 'position startpos',
    depth: 10
  });
  assert.ok(single.bestmove && single.bestmove.length >= 4);
});
