# Mars Live

**Consent-first shared browser control for Chrome.**

Mars Live lets a controller view and operate **one web tab** while the host stays in charge. It is a standalone Chrome extension plus a small local relay and browser controller. The existing Chess.com analysis extension at the repository root is unchanged.

## What makes it consent-first

1. **Pin required.** The popup asks the user to pin Mars Live before starting a session.
2. **Chrome accepts the share.** The native `desktopCapture` picker is used; no tab is captured before the user chooses it.
3. **A controller is view-only.** Pairing with the six-digit code does not grant input access.
4. **Input is separately approved.** The host must click **Allow control** before mouse or keyboard events are accepted.
5. **The host can always interrupt.** The shared tab has a persistent Mars Live banner with **Pause** and **Stop**. The local mouse is never blocked.
6. **Sessions are ephemeral.** Closing the session window stops capture and invalidates the pairing code. The relay keeps sessions and frames in memory only.

## Quick start

### 1. Run the controller relay

```bash
cd live-control/relay
npm install
npm start
```

The default address is `http://127.0.0.1:8787`, and the default WebSocket URL is `ws://127.0.0.1:8787/ws`.

### 2. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the **`live-control/extension`** folder (the folder containing `manifest.json`).
5. Click Chrome's puzzle icon and **pin Mars Live** to the toolbar.

### 3. Start a session from a web tab

1. Open a regular `http://` or `https://` tab.
2. Click the pinned **Mars Live** extension.
3. Confirm the relay URL (the local default is already filled in), then click **Start a live session**.
4. In the session window, click **Choose tab & share**.
5. Select the intended tab in Chrome's native prompt and accept.

The session window shows the live preview and a six-digit pairing code. Chrome's sharing indicator and the Mars Live banner remain visible on the shared tab.

### 4. Connect a controller

1. Open `http://127.0.0.1:8787` in the controller browser.
2. Enter the six-digit code and click **View session**.
3. The controller arrives **view-only**.
4. Click **Request control** in the controller.
5. The host reviews the request in the session window or the tab banner and clicks **Allow control**.

Click the shared screen in the controller to focus it for keyboard input. Mouse movement, clicks, dragging, scrolling, and keyboard input are then sent to the shared tab. The host can pause, revoke, or stop at any time. The local mouse remains usable.

## Security model and scope

### What is shared

- Only the tab selected in Chrome's native picker.
- The captured viewport is sent as live JPEG frames through the configured relay while a controller is connected.
- Mouse and keyboard input is accepted only while the host has granted control and has not paused it.
- No recording, frame storage, account, or persistent remote-access credential is created.

### What is not controlled

This is a **web-tab controller**, not a desktop remote-control tool. It does not control:

- Chrome's address bar, toolbar, tabs, settings, or other browser chrome
- Other browser tabs or windows
- The operating system or native applications
- `chrome://` pages, the Chrome Web Store, or other pages where Chrome blocks extension scripting

Chrome displays its debugger indicator when input is enabled because Mars Live uses the Chrome DevTools Protocol to deliver trusted mouse/keyboard events to the selected tab. That indicator is intentional and should not be hidden.

### Relay trust

The default relay binds to `127.0.0.1` and is intended for local use. Frames pass through the relay; they are **not end-to-end encrypted**. For remote use, deploy the relay on a trusted host, use HTTPS/WSS, and enter the `wss://` URL in the extension's **Controller relay** settings. Do not expose the default plain-HTTP relay to an untrusted network. The six-digit code is a short-lived pairing secret, not a substitute for network access controls.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Grants temporary access to the tab the user explicitly shares. |
| `desktopCapture` | Opens Chrome's native tab-sharing picker. |
| `scripting` | Shows the consent/stop banner in the selected tab. |
| `debugger` | Sends trusted mouse and keyboard events to the selected tab after approval. |
| `storage` | Saves the relay URL and the current session window locally. |
| Optional host permissions | Requests access to the configured HTTP(S)/WS(S) relay origin when needed. |

## Troubleshooting

- **Start button stays disabled:** pin Mars Live using Chrome's puzzle menu, then click **Refresh** in the popup. The active tab must be a regular web page.
- **Relay offline:** run `npm start` in `live-control/relay` and check the WebSocket URL. The controller page's badge shows the health check result.
- **Controller cannot join:** confirm the code is current, the session window is still open, and no other controller is already connected.
- **Allow control fails:** close DevTools or another extension debugger attached to the target tab, then request control again.
- **Banner disappears after navigation:** the session page attempts to reinject it. If Chrome blocks scripting on the destination, use the session window's **Stop session** button.

## Development

```bash
cd live-control/relay
npm run check
npm test
```

The tests cover the controller page and health routes, denial of input before host approval, host-approved input and frame relay, and session teardown.

### File map

- `extension/` — Manifest V3 extension: popup, live session panel, tab banner, and consent logic.
- `relay/server.js` — In-memory WebSocket relay and static controller server.
- `relay/public/` — Browser controller UI.
- `relay/server.test.js` — Protocol and lifecycle tests.

### Relay message contract

The extension registers as host with `host-register`; the controller joins with `controller-join`. The host publishes `host-state` and `control-result` messages. The controller sends `request-control` and, only after host approval, `input` messages. Live frames are `frame` messages containing a JPEG data URL. `host-end`, host disconnect, or window close tears down the session and closes the controller.
