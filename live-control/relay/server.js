import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const MAX_PAYLOAD = 2 * 1024 * 1024;
const INPUT_KEYS = new Set([
  'x', 'y', 'button', 'clickCount', 'deltaX', 'deltaY', 'key', 'code', 'keyCode',
  'location', 'text', 'repeat', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey'
]);
const ACTIONS = new Set(['move', 'down', 'up', 'wheel', 'key-down', 'key-up']);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const staticFiles = new Map([
  ['/', ['controller.html', 'text/html; charset=utf-8']],
  ['/controller.css', ['controller.css', 'text/css; charset=utf-8']],
  ['/controller.js', ['controller.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']]
]);

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(message)); } catch (error) { /* The close handler cleans up. */ }
  }
}

function cleanHostState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    targetTitle: typeof source.targetTitle === 'string' ? source.targetTitle.slice(0, 180) : '',
    sharing: source.sharing === true,
    controllerConnected: source.controllerConnected === true,
    controlGranted: source.controlGranted === true,
    paused: source.paused === true,
    requestPending: source.requestPending === true
  };
}

function cleanInput(message) {
  if (!ACTIONS.has(message.action)) return null;
  const result = { type: 'input', action: message.action };
  for (const key of INPUT_KEYS) {
    if (!(key in message)) continue;
    const value = message[key];
    if (typeof value === 'string') result[key] = value.slice(0, key === 'text' ? 4 : 50);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

export function createRelayServer() {
  const sessions = new Map();
  const joinAttempts = new Map();
  let heartbeat;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/health') {
      const body = JSON.stringify({ ok: true, sessions: sessions.size });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body)
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const entry = staticFiles.get(url.pathname);
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Not found');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', 'allow': 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }
    try {
      const body = await readFile(path.join(publicDir, entry[0]));
      res.writeHead(200, {
        'content-type': entry[1],
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; media-src 'self' blob:; base-uri 'none'; form-action 'self'"
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Controller asset unavailable');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.sessionMeta = {
      role: null,
      code: null,
      alive: true,
      inputWindowAt: 0,
      inputCount: 0,
      deniedAt: 0
    };
    ws.on('pong', () => { ws.sessionMeta.alive = true; });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
        if (!message || typeof message.type !== 'string') return;
      } catch (error) {
        send(ws, { type: 'error', message: 'Malformed message' });
        return;
      }
      const meta = ws.sessionMeta;
      const now = Date.now();

      if (message.type === 'host-register') {
        if (meta.role) return;
        const code = typeof message.code === 'string' ? message.code : '';
        const token = typeof message.token === 'string' ? message.token : '';
        if (!/^\d{6}$/.test(code) || token.length < 32) {
          send(ws, { type: 'error', message: 'Invalid host registration' });
          return;
        }
        if (sessions.has(code)) {
          send(ws, { type: 'error', code: 'code-in-use', message: 'This pairing code is already in use' });
          return;
        }
        meta.role = 'host';
        meta.code = code;
        sessions.set(code, {
          host: ws,
          token,
          controller: null,
          controlGranted: false,
          createdAt: now,
          hostState: {}
        });
        send(ws, { type: 'host-ready', code });
        return;
      }

      if (message.type === 'controller-join') {
        if (meta.role) return;
        const code = typeof message.code === 'string' ? message.code : '';
        const ip = req.socket.remoteAddress || 'local';
        let attempt = joinAttempts.get(ip);
        if (!attempt || now - attempt.at > 60000) {
          attempt = { at: now, count: 0 };
          joinAttempts.set(ip, attempt);
        }
        attempt.count += 1;
        if (attempt.count > 30) {
          send(ws, { type: 'error', code: 'rate-limited', message: 'Too many pairing attempts. Wait a minute.' });
          return;
        }
        if (!/^\d{6}$/.test(code) || !sessions.has(code) || sessions.get(code).host.readyState !== WebSocket.OPEN) {
          send(ws, { type: 'error', code: 'not-found', message: 'Session not found. Check the code and try again.' });
          return;
        }
        const session = sessions.get(code);
        if (session.controller && session.controller.readyState === WebSocket.OPEN) {
          send(ws, { type: 'error', code: 'already-connected', message: 'This session already has a controller.' });
          return;
        }
        meta.role = 'controller';
        meta.code = code;
        session.controller = ws;
        send(ws, {
          type: 'controller-ready',
          code,
          controlGranted: session.controlGranted,
          hostState: session.hostState
        });
        send(session.host, { type: 'controller-joined' });
        return;
      }

      if (!meta.role || !meta.code) return;
      const session = sessions.get(meta.code);
      if (!session) return;

      if (meta.role === 'host') {
        if (message.type === 'host-state') {
          session.controlGranted = message.controlGranted === true;
          session.hostState = cleanHostState(message);
          send(session.controller, { type: 'host-state', ...session.hostState });
        } else if (message.type === 'control-result') {
          send(session.controller, { type: 'control-result', approved: message.approved === true });
        } else if (message.type === 'frame') {
          if (!session.controller || session.controller.readyState !== WebSocket.OPEN) return;
          if (typeof message.data !== 'string' || message.data.length > 1900000 || !message.data.startsWith('data:image/jpeg;base64,')) return;
          if (!Number.isInteger(message.width) || !Number.isInteger(message.height)) return;
          send(session.controller, {
            type: 'frame',
            sequence: Number(message.sequence) || 0,
            width: message.width,
            height: message.height,
            data: message.data
          });
        } else if (message.type === 'host-end') {
          if (message.token !== session.token) return;
          send(session.controller, { type: 'session-ended', message: 'The host ended the session.' });
          if (session.controller) session.controller.close(4000, 'Session ended');
          session.host.close(1000, 'Session ended');
          sessions.delete(meta.code);
        } else if (message.type === 'ping') {
          send(ws, { type: 'pong' });
        }
        return;
      }

      if (message.type === 'request-control') {
        send(session.host, { type: 'request-control' });
      } else if (message.type === 'control-result') {
        // Controllers do not grant control; only the host can do that.
        send(ws, { type: 'control-denied' });
      } else if (message.type === 'input') {
        if (!session.controlGranted || session.host.readyState !== WebSocket.OPEN) {
          if (now - meta.deniedAt > 500) {
            send(ws, { type: 'control-denied' });
            meta.deniedAt = now;
          }
          return;
        }
        if (now - meta.inputWindowAt > 1000) {
          meta.inputWindowAt = now;
          meta.inputCount = 0;
        }
        meta.inputCount += 1;
        if (meta.inputCount > 120) return;
        const input = cleanInput(message);
        if (input) send(session.host, input);
      } else if (message.type === 'ping') {
        send(ws, { type: 'pong' });
      }
    });

    ws.on('close', () => {
      const meta = ws.sessionMeta;
      if (!meta || !meta.role || !meta.code) return;
      const session = sessions.get(meta.code);
      if (!session) return;
      if (meta.role === 'host') {
        if (session.controller) {
          send(session.controller, { type: 'session-ended', message: 'The host disconnected.' });
          session.controller.close(4001, 'Host disconnected');
        }
        sessions.delete(meta.code);
      } else if (session.controller === ws) {
        session.controller = null;
        session.controlGranted = false;
        send(session.host, { type: 'controller-left' });
      }
    });
  });

  heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.sessionMeta || !ws.sessionMeta.alive) {
        ws.terminate();
        continue;
      }
      ws.sessionMeta.alive = false;
      try { ws.ping(); } catch (error) { ws.terminate(); }
    }
  }, 15000);

  async function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  return { server, wss, sessions, close };
}

async function main() {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const relay = createRelayServer();
  relay.server.listen(port, host, () => {
    console.log(`Mars Live relay listening on http://${host}:${port}`);
    console.log('Default bind is localhost. Use HOST=0.0.0.0 only on a trusted network.');
  });
  const shutdown = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
