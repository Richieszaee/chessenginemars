# Mars Live

**Consent-first shared browser control for Chrome.**

Mars Live lets a controller view and operate **one web tab** while the host stays in charge. It is a standalone Chrome extension plus **one PHP file** that acts as the bridge. There is no controller website — the controller UI is inside the extension too, so both people install the same extension. The existing Chess.com analysis extension at the repository root is unchanged.

## What makes it consent-first

1. **Pin required.** The popup asks the user to pin Mars Live before starting a session.
2. **Chrome accepts the share.** The native `desktopCapture` picker is used; no tab is captured before the user chooses it.
3. **A controller is view-only.** Joining with the six-digit PIN does not grant input access.
4. **Input is separately approved.** The host must click **Allow control** before mouse or keyboard events are accepted.
5. **The host can always interrupt.** The shared tab has a persistent Mars Live banner with **Pause** and **Stop**. The local mouse is never blocked.
6. **Sessions are ephemeral.** Closing the session window stops capture and invalidates the PIN. The bridge keeps sessions in short-lived files that expire on their own.

## Quick start

### 1. Put `bridge.php` on a PHP host

Copy **`live-control/bridge/bridge.php`** to any ordinary PHP hosting (shared hosting, cPanel, a VPS, a home server). It needs:

- PHP 7.4 or newer with the `json` extension (standard in every PHP build)
- A writable `data/` directory **next to** `bridge.php`

The bridge writes small session files into that `data/` folder and cleans them up itself. There is no database, no Node.js, no WebSocket server, and no build step.

The address will look like `https://your-domain.com/mars-live/bridge.php`.

<details>
<summary>Local testing with PHP's built-in server</summary>

```bash
cd live-control/bridge
php -S 127.0.0.1:8080
```

The bridge is then at `http://127.0.0.1:8080/bridge.php`, which is the extension's default address.

</details>

### 2. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the **`live-control/extension`** folder (the folder containing `manifest.json`).
5. Click Chrome's puzzle icon and **pin Mars Live** to the toolbar.

To install from the zip instead: unzip `mars-live-extension.zip` and load the resulting folder the same way.

### 3. Set the bridge address once

Click the pinned **Mars Live** icon, open **Connection settings**, paste the `bridge.php` address, and click **Save**. Chrome asks for permission to reach that host — this is normal and only happens once.

### 4. Start a session from a web tab

1. Open a regular `http://` or `https://` tab.
2. Click the pinned **Mars Live** extension and click **Connect**.
3. In the session window, click **Choose tab & share**.
4. Select the intended tab in Chrome's native prompt and accept.

The session window shows the live preview and a six-digit PIN. Chrome's sharing indicator and the Mars Live banner remain visible on the shared tab. The popup also shows **Your PIN** when you reopen it during a live session.

### 5. Connect a controller

Both people use the same extension — there is no website to open.

1. On the other computer, install Mars Live and set the **same** bridge address in **Connection settings**.
2. Click the pinned **Mars Live** icon and click **Join with PIN**.
3. Enter the six-digit PIN and click **Connect**. The controller arrives **view-only**.
4. Click **Request control** in the controller.
5. The host reviews the request in the session window or the tab banner and clicks **Allow control**.

Click the shared screen in the controller to focus it for keyboard input. Mouse movement, clicks, dragging, scrolling, and keyboard input are then sent to the shared tab. The host can pause, revoke, or stop at any time. The local mouse remains usable.

**Tip:** the host can click **Copy invite details** in the popup and send one message that already contains the bridge address and the PIN.

## Different Wi-Fi networks

Mars Live works across different networks as soon as `bridge.php` is reachable from both computers — for example on ordinary shared hosting or any VPS with a domain. Nothing else is required: no tunnel, no WebSocket port, no Node process.

See [`REMOTE.md`](REMOTE.md) for hosting notes, HTTPS, and the `data/` permissions.

## Security model and scope

### What is shared

- Only the tab selected in Chrome's native picker.
- The captured viewport is sent as live JPEG frames through the configured bridge while a controller is connected.
- Mouse and keyboard input is accepted only while the host has granted control and has not paused it.
- No recording, frame storage, account, or persistent remote-access credential is created.

### What is not controlled

This is a **web-tab controller**, not a desktop remote-control tool. It does not control:

- Chrome's address bar, toolbar, tabs, settings, or other browser chrome
- Other browser tabs or windows
- The operating system or native applications
- `chrome://` pages, the Chrome Web Store, or other pages where Chrome blocks extension scripting

Chrome displays its debugger indicator when input is enabled because Mars Live uses the Chrome DevTools Protocol to deliver trusted mouse/keyboard events to the selected tab. That indicator is intentional and should not be hidden.

### Bridge trust

Frames pass through the bridge; they are **not end-to-end encrypted**. Host the bridge on infrastructure you control and use HTTPS. The bridge stores only the latest frame per session, in memory-tiny files that expire; it never writes an archive.

Tokens are 256-bit random values, stored on the bridge only as SHA-256 hashes and compared in constant time. The six-digit PIN is a short-lived pairing secret, not a substitute for network access controls — anyone who learns the PIN can join as a viewer, but they still cannot send input until the host clicks **Allow control**.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Grants temporary access to the tab the user explicitly shares. |
| `desktopCapture` | Opens Chrome's native tab-sharing picker. |
| `scripting` | Shows the consent/stop banner in the selected tab. |
| `debugger` | Sends trusted mouse and keyboard events to the selected tab after approval. |
| `storage` | Saves the bridge address and the current session window locally. |
| Optional host permissions | Requests access to the configured HTTP(S) bridge origin when needed. |

## Troubleshooting

- **Start button stays disabled:** pin Mars Live using Chrome's puzzle menu, then click **Refresh** in the popup. The active tab must be a regular web page.
- **PHP bridge offline:** open the bridge address directly in a browser. A working bridge prints `{"ok":true,"bridge":"php","sessions":0}`. If you see a blank page or an error, check the PHP version and that `data/` is writable.
- **Controller cannot join:** confirm the PIN is current, the session window is still open, and no other controller is already connected.
- **Allow control fails:** close DevTools or another extension debugger attached to the target tab, then request control again.
- **Banner disappears after navigation:** the session page attempts to reinject it. If Chrome blocks scripting on the destination, use the session window's **Stop session** button.

## Development

There is nothing to build for the bridge — it is a single PHP file. The extension is plain HTML/CSS/JS with no bundler.

```bash
php -l live-control/bridge/bridge.php
```

To exercise the protocol quickly, open the bridge with `?action=health` in a browser.

### File map

- `extension/` — Manifest V3 extension: popup, host session panel, in-extension controller, tab banner, and consent logic.
- `bridge/bridge.php` — The whole bridge: file-based sessions, HTTP polling, input and frame relay.
- `bridge/data/` — Writable session store. Protected by `.htaccess`; keep it out of version control.
- `bridge/.htaccess` — Sends `X-Content-Type-Options: nosniff`.

### Bridge API contract

Every request is a JSON `POST` to `bridge.php` with an `action` field. Responses are JSON with `ok: true` on success, or `ok: false` plus `error` and `message` on failure. Parameters may also arrive as `$_GET` or form fields.

| Action | Params | Result |
| --- | --- | --- |
| `health` | — | `{ok, bridge:"php", sessions}` |
| `register` | `code`, `host_token` | Creates or resumes the session. `409 code-in-use` if a live host holds a different token. |
| `join` | `code` | Returns a fresh `controller_token`. `404 not-found`, `409 host-offline`, `409 already-connected`. |
| `host_poll` | `code`, `host_token`, `after` | `state` + events addressed to the host. |
| `controller_poll` | `code`, `controller_token`, `after`, `after_frame` | `state` + events + optional `frame`. |
| `state` | `code`, `host_token`, `state` | Host pushes consent flags (`controlGranted`, `paused`, `requestPending`, `targetTitle`). |
| `control` | `code`, `host_token`, `grant` | Sets `control_granted` and queues `control-result` for the controller. |
| `request_control` | `code`, `controller_token` | Queues `request-control` for the host. |
| `input` | `code`, `controller_token`, `input` | `403 control-denied` unless granted and unpaused. Rate limited to 120/s. |
| `frame` | `code`, `host_token`, `sequence`, `width`, `height`, `data` | Stores the latest JPEG data URL. `413` above 1.6 MB. |
| `leave` | `code`, `controller_token` | Removes the controller and queues `controller-left`. |
| `end` | `code`, `host_token` | Deletes the session and queues `session-ended`. |

Events carry a monotonically increasing `id`, so each peer polls with the last `id` it has seen. Sessions expire after 30 minutes, and a peer that stops polling for 5 seconds is treated as offline.
