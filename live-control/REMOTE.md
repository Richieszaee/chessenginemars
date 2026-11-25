# Mars Live across different Wi-Fi networks

Mars Live does not need both computers on the same Wi-Fi. It needs a relay that both computers can reach over the internet. The extension is installed only on the computer sharing its tab; the other computer uses the browser controller.

The easiest temporary setup is a Cloudflare Quick Tunnel. A Quick Tunnel URL changes when the tunnel restarts. For a permanent address, deploy the relay to a Node host instead.

## Quick setup: different Wi-Fi in a few minutes

### On the computer sharing its browser

1. Install [Cloudflare's `cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and keep it available in your terminal.
2. Start the relay locally:

   ```bash
   cd live-control/relay
   npm install
   npm start
   ```

3. In a second terminal, start a temporary public tunnel:

   ```bash
   cloudflared tunnel --url http://127.0.0.1:8787
   ```

4. Copy the printed `https://…trycloudflare.com` address. Keep both terminals open.
5. Open Mars Live's **Controller relay** settings and paste that HTTPS address. The extension converts it to `wss://…/ws` and asks Chrome for permission to use that relay.
6. Start a live session and choose the tab in Chrome's share prompt.

### On the other computer, anywhere with internet

1. Open the same `https://…trycloudflare.com` address in a browser.
2. Enter the six-digit PIN from the host's Mars Live window, or use the popup’s **Open controller website** button to fill it in automatically.
3. Click **Connect**, then **Request control**.
4. The host clicks **Allow control**. Until then, the controller is view-only.

The host can pause, revoke, or stop the session at any time, and the local mouse always works.

## Permanent internet relay

You can run the same relay on a Node hosting service, VPS, home server, or cloud VM:

```bash
cd live-control/relay
npm ci
HOST=0.0.0.0 PORT=8787 npm start
```

Put HTTPS/WSS in front of it with a reverse proxy or your host's managed TLS. Then:

- Set the extension's **Controller relay** to `wss://your-relay.example.com/ws`.
- Open `https://your-relay.example.com` on the controller computer.

For a quick container deployment, use the included `Dockerfile` in `live-control/relay/`:

```bash
docker build -t mars-live-relay .
docker run --rm -p 8787:8787 -e HOST=0.0.0.0 mars-live-relay
```

## Important security notes

- The relay and tunnel provider can see the live tab frames. This is **not end-to-end encrypted**. Use a provider and network you trust, and close the tunnel when you are done.
- Do not expose the default plain-HTTP relay directly to the internet. Use HTTPS/WSS.
- The public controller URL is not the pairing secret. The six-digit code is short-lived, and mouse/keyboard control still requires the host's explicit approval.
- A Quick Tunnel is for temporary use. Use a persistent relay with a stable address for regular sessions.
