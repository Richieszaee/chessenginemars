# Bossfrommars Analysis — Arrows & Move Labels

A Chrome extension for **chess.com** that shows live Stockfish analysis *and* chess.com-style
move labels while you play: **Brilliant**, **Great move**, **Best**, **Excellent**, **Book**,
**Inaccuracy**, **Mistake**, **Blunder** and **Miss**.

## Icons — chess.com's own artwork

The move labels use **chess.com's actual "Move Classification" vector files** (from their public
brand assets), embedded verbatim in `icons.js` — the same 18x19 artwork, the same official fills,
the same inner shadow and highlight. That is why the panel, the pop-up and the board badge look
identical to Game Review.

| Icon | Label | Official fill |
|---|---|---|
| `!!` | **Brilliant** | `#1bada6` |
| `!` | **Great move** | `#1bada6` |
| ★ | **Best move** | `#96bc4b` |
| 👍 | **Excellent** | `#96bc4b` |
| ✓ | **Good** | `#96af8b` |
| ▬ | **Book** | `#a88865` |
| `?!` | **Inaccuracy** | `#f7c045` |
| `?` | **Mistake** | `#e58f2a` |
| ✗ | **Miss** | `#ca3431` |
| `??` | **Blunder** | `#ca3431` |
| ➡ | **Forced** | `#b0b0b0` (drawn to match) |

They appear in four places: the pop-up, the last-move card, the recent-moves strip, and directly
on the board — chess.com's coloured **square tint** on the destination square plus the disc badge
in its corner.

> Move-classification artwork © Chess.com, taken from their public brand resources and used here
> for personal, non-commercial analysis. If you republish this, credit Chess.com.

---



## What it does

| Feature | Details |
|---|---|
| **Best-move arrows** | Top 1–4 engine moves drawn straight on the board, numbered, with a continuation preview. Hover a move in the panel to isolate its arrow. |
| **Live move labels** | Every move you (or your opponent) play is graded the moment the engine has the new position. A chess.com-style pop-up announces it, the last move is kept in a card, and a badge appears on the destination square. |
| **Eval bar** | Smooth win-probability bar, left or right of the board, with mate and result aware labelling. |
| **Opening book** | Moves inside known theory are tagged **Book** instead of being graded. |
| **Recent moves strip** | Colour-coded chips of the last moves with their symbols (`!!`, `!`, `★`, `?!`, `?`, `??`). |
| **Panel** | Draggable, minimisable, custom background image, dark glass design that matches chess.com's own analysis UI. |

### How a move gets its label

The engine searches the position **before** your move (MultiPV) and then the position **after** it.
Labels are derived from the *win-probability* those evaluations imply, which is what keeps them
sensible when one side is already winning:

* **Best** – you played the engine's first choice.
* **Brilliant** – the best move, *and* it offers material for less than it is worth (a real
  sacrifice) while the evaluation still holds up.
* **Great** – the best move, and it was the only move that works, or it punishes an
  undefended piece.
* **Excellent / Good** – tiny or small win-probability drop.
* **Book** – still in known opening theory.
* **Inaccuracy / Mistake / Blunder** – increasing loss of winning chances.
* **Miss** – a winning position was let go in a single move.
* **Forced** – there was only one legal move.

Thresholds live in `review.js` (`classify()`), so they are easy to tune.

---

## Install (unpacked)

1. Download `bossfrommars-analysis-2.2.0.zip` and unzip it (or use this repository folder).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → pick the unzipped folder (the one containing `manifest.json`).
4. Open any chess.com analysis board, bot game, or finished game.

Reload the chess.com tab after installing or updating.

## Shortcuts

| Key | Action |
|---|---|
| `Alt` + `A` | Analysis on / off |
| `Alt` + `M` | Minimise / expand the panel |
| `Alt` + `S` | Open the settings |

## Settings

* **Move labels / Label pop-up / Badge on board / Opening book** – toggle each piece of the labelling.
* **Eval bar** – off, left of the board, or right of the board.
* **Arrows shown** – 1 to 4 engine lines.
* **Engine depth** – 14 (fast) → ∞ (keep thinking).
* **Panel background** – your own image, processed and stored locally (never uploaded).

---

## Where it runs

`/analysis`, `/play`, `/game`, `/play/computer`, `/game/computer`, bot games and finished games.
If you want it on any chess.com page, turn on **Show on every page** in settings.

> The extension stays off rated human games by default — it is built for analysis boards and
> games against bots. Using engine assistance in rated games breaks chess.com's fair-play rules.

## Development

```
manifest.json      MV3 manifest
background.js      service worker: routes tab ⇄ offscreen engine messages
offscreen.html/js  runs Stockfish 19 Lite in a Web Worker
page.js            MAIN-world script: reads chess.com's board object (FEN, flip)
content.js         panel, arrows, eval bar, toast, label pipeline
review.js          move classification (labels, book, sacrifice tests)
icons.js           chess.com icon set (shapes + palette) as inline SVG
content.css        all UI styling
chess.js           chess.js (move generation / SAN / PGN)
stockfish-*.js/.wasm  Stockfish 19 Lite (single file, no threads)
preview/           static preview with a scripted engine (open preview/index.html)
build.sh           builds dist/*.zip
```

Preview locally:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/preview/
```

The preview stubs `chrome.*` and the engine, but runs the real `content.js`, `review.js` and
`content.css`, so you can see every label without touching chess.com.

## Credits

* [Stockfish](https://stockfishchess.org/) — GPLv3, see `STOCKFISH-LICENSE.txt`.
* [chess.js](https://github.com/jhlywa/chess.js) — BSD.
