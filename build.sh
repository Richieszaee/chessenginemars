#!/usr/bin/env bash
# Builds dist/bossfrommars-analysis-<version>.zip — the folder you upload to
# chrome://extensions ("Load unpacked" after unzipping, or pack from there).
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -e "console.log(require('./manifest.json').version)")
OUT="dist"
NAME="bossfrommars-analysis-${VERSION}"

FILES=(
  manifest.json
  background.js
  offscreen.html
  offscreen.js
  page.js
  content.js
  content.css
  chess.js
  review.js
  stockfish-19-lite-single.js
  stockfish-19-lite-single.wasm
  icon16.png
  icon48.png
  icon128.png
  STOCKFISH-LICENSE.txt
  README.md
)

mkdir -p "$OUT"
rm -f "$OUT/${NAME}.zip"

STAGE=$(mktemp -d)
mkdir -p "$STAGE/$NAME"
for f in "${FILES[@]}"; do
  cp "$f" "$STAGE/$NAME/$f"
done

(cd "$STAGE" && zip -rq "$OLDPWD/$OUT/${NAME}.zip" "$NAME")
rm -rf "$STAGE"

echo "built $OUT/${NAME}.zip"
unzip -l "$OUT/${NAME}.zip"
