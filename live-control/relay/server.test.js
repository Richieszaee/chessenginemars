import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createRelayServer } from './server.js';

function openClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws, type, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeout);
    function onMessage(raw) {
      let message;
      try { message = JSON.parse(String(raw)); } catch (error) { return; }
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

async function startRelay(t) {
  const relay = createRelayServer();
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const ws of relay.wss.clients) ws.terminate();
    await relay.close();
  });
  const port = relay.server.address().port;
  return { relay, url: `ws://127.0.0.1:${port}/ws`, http: `http://127.0.0.1:${port}` };
}

test('static controller and health routes respond', async (t) => {
  const { http, relay } = await startRelay(t);
  const health = await fetch(`${http}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, sessions: 0 });
  const page = await fetch(`${http}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Connect/);
  const connectPage = await fetch(`${http}/connect`);
  assert.equal(connectPage.status, 200);
  assert.match(connectPage.headers.get('content-type'), /text\/html/);
  assert.equal(relay.sessions.size, 0);
});

test('controller is denied input until host approval, then receives frames', async (t) => {
  const { url } = await startRelay(t);
  const host = await openClient(url);
  const hostReady = nextMessage(host, 'host-ready');
  host.send(JSON.stringify({ type: 'host-register', code: '123456', token: 'a'.repeat(64) }));
  await hostReady;

  const controller = await openClient(url);
  const ready = nextMessage(controller, 'controller-ready');
  controller.send(JSON.stringify({ type: 'controller-join', code: '123456' }));
  const readyMessage = await ready;
  assert.equal(readyMessage.controlGranted, false);

  const denied = nextMessage(controller, 'control-denied');
  controller.send(JSON.stringify({ type: 'input', action: 'move', x: 0.2, y: 0.3 }));
  await denied;

  const stateMessage = nextMessage(controller, 'host-state');
  host.send(JSON.stringify({ type: 'host-state', controlGranted: true, paused: false, requestPending: false }));
  assert.equal((await stateMessage).controlGranted, true);

  const input = nextMessage(host, 'input');
  controller.send(JSON.stringify({ type: 'input', action: 'down', x: 0.5, y: 0.5, button: 'left', clickCount: 1 }));
  const inputMessage = await input;
  assert.equal(inputMessage.action, 'down');
  assert.equal(inputMessage.button, 'left');

  const frame = nextMessage(controller, 'frame');
  host.send(JSON.stringify({
    type: 'frame', sequence: 1, width: 640, height: 360, data: 'data:image/jpeg;base64,AA=='
  }));
  const frameMessage = await frame;
  assert.equal(frameMessage.width, 640);
  assert.equal(frameMessage.sequence, 1);

  const ended = nextMessage(controller, 'session-ended');
  host.send(JSON.stringify({ type: 'host-end', token: 'a'.repeat(64) }));
  await ended;
});

test('host disconnect closes the paired controller', async (t) => {
  const { url } = await startRelay(t);
  const host = await openClient(url);
  const hostReady = nextMessage(host, 'host-ready');
  host.send(JSON.stringify({ type: 'host-register', code: '654321', token: 'b'.repeat(64) }));
  await hostReady;
  const controller = await openClient(url);
  const ready = nextMessage(controller, 'controller-ready');
  controller.send(JSON.stringify({ type: 'controller-join', code: '654321' }));
  await ready;
  const ended = nextMessage(controller, 'session-ended');
  host.close();
  await ended;
});
