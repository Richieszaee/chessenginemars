# chessenginemars

This repository contains two separate Chrome projects:

- **Root** — Bossfrommars Analysis Arrows, the existing Chess.com Stockfish analysis extension. Load the repository root as an unpacked extension.
- **`live-control/`** — **Mars Live**, a consent-first browser-tab sharing and control extension with a local relay and browser controller. See [`live-control/README.md`](live-control/README.md) for installation, the approval flow, security boundaries, and development commands.

Mars Live requires the user to pin the extension, accept Chrome's native tab-sharing prompt, and separately approve mouse/keyboard control. The host can pause or stop the session at any time, and the local mouse always works.
