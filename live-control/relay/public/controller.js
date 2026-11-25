const $ = (id) => document.getElementById(id);
const state = {
  socket: null,
  connected: false,
  granted: false,
  paused: false,
  requestPending: false,
  code: '',
  lastSequence: 0,
  lastMoveAt: 0,
  pointerDown: false,
  pointerButton: 'left',
  pressedKeys: new Set(),
  hasFrame: false,
  resetting: false,
  toastTimer: 0,
  requestTimer: 0
};
const canvas = $('screen');
const ctx = canvas.getContext('2d', { alpha: false });

function toast(message) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600);
}

function setJoinError(message) {
  $('joinError').textContent = message || '';
  $('joinError').hidden = !message;
}

function setJoining(joining) {
  $('joinButton').disabled = joining;
  $('joinButton').querySelector('span').textContent = joining ? 'Connecting…' : 'Connect';
  $('codeInput').disabled = joining;
}

function canControl() {
  return state.connected && state.granted && !state.paused && state.socket && state.socket.readyState === WebSocket.OPEN;
}

function resetToLanding(message) {
  state.resetting = true;
  if (state.socket) {
    state.socket.onclose = null;
    try { state.socket.close(); } catch (error) {}
    state.socket = null;
  }
  clearTimeout(state.requestTimer);
  state.connected = false;
  state.granted = false;
  state.paused = false;
  state.requestPending = false;
  state.pointerDown = false;
  state.pressedKeys.clear();
  state.hasFrame = false;
  state.lastSequence = 0;
  state.code = '';
  state.resetting = false;
  $('liveApp').hidden = true;
  $('landing').hidden = false;
  document.body.classList.remove('is-live');
  setJoining(false);
  if (message) {
    setJoinError(message);
    $('codeInput').focus();
  }
}

function updateControlUI() {
  const live = canControl();
  const pill = $('controlPill');
  pill.className = 'control-pill';
  if (state.requestPending) {
    pill.textContent = 'REQUESTED';
    pill.classList.add('requested');
  } else if (state.granted && state.paused) {
    pill.textContent = 'PAUSED';
    pill.classList.add('paused');
  } else if (state.granted) {
    pill.textContent = 'CONTROL LIVE';
    pill.classList.add('granted');
  } else {
    pill.textContent = 'VIEW ONLY';
  }
  $('dockLight').className = `dock-light ${state.requestPending ? 'requested' : state.granted && !state.paused ? 'granted' : ''}`;
  $('dockTitle').textContent = state.requestPending
    ? 'Waiting for the host'
    : state.granted
      ? (state.paused ? 'Control is paused' : 'You have control')
      : 'You’re view-only';
  $('dockHint').textContent = state.requestPending
    ? 'The host must approve mouse and keyboard access.'
    : state.granted
      ? (state.paused ? 'Your input is paused. The host can resume it.' : 'Mouse and keyboard go to the shared tab. Your local browser stays separate.')
      : 'The host can allow mouse and keyboard control at any time.';
  const button = $('requestControlButton');
  button.hidden = state.granted;
  button.disabled = state.requestPending || !state.connected;
  button.textContent = state.requestPending ? 'Waiting for approval…' : 'Request control';
  $('inputHint').textContent = live ? 'INPUT LIVE · CLICK SCREEN TO FOCUS' : 'INPUT LOCKED BY HOST';
  canvas.classList.toggle('control-live', live);
  if (!state.hasFrame) $('screenMeta').textContent = 'HOST APPROVAL REQUIRED FOR INPUT';
  $('cursorHint').textContent = live ? 'MOVE TO INSPECT · CLICK TO INTERACT' : 'VIEW ONLY · INPUT LOCKED';
}

function showLive() {
  $('liveCode').textContent = state.code;
  $('liveApp').hidden = false;
  $('landing').hidden = true;
  document.body.classList.add('is-live');
  $('screenWaiting').hidden = state.hasFrame;
  updateControlUI();
}

function drawFrame(message) {
  if (!Number.isInteger(message.width) || !Number.isInteger(message.height)) return;
  if (typeof message.data !== 'string' || !message.data.startsWith('data:image/jpeg;base64,')) return;
  const sequence = Number(message.sequence) || 0;
  if (sequence <= state.lastSequence) return;
  state.lastSequence = sequence;
  const image = new Image();
  image.onload = () => {
    if (!state.connected) return;
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.drawImage(image, 0, 0);
    state.hasFrame = true;
    $('screenWaiting').hidden = true;
    $('screenMeta').textContent = `${image.width} × ${image.height}`;
    updateControlUI();
  };
  image.src = message.data;
}

function handleMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'controller-ready': {
      state.connected = true;
      state.code = message.code || state.code;
      const host = message.hostState || {};
      state.granted = message.controlGranted === true && host.controlGranted === true;
      state.paused = state.granted && host.paused === true;
      state.requestPending = host.requestPending === true;
      showLive();
      break;
    }
    case 'host-state': {
      const wasPending = state.requestPending;
      const wasGranted = state.granted;
      state.granted = message.controlGranted === true;
      state.paused = state.granted && message.paused === true;
      state.requestPending = message.requestPending === true;
      if (!state.granted) state.pressedKeys.clear();
      if (state.granted && !wasGranted) {
        toast('Control approved. Click the screen to send mouse and keyboard input.');
        canvas.focus();
      } else if (wasGranted && !state.granted) {
        toast('Control revoked by the host. You are view-only again.');
      } else if (wasPending && !state.requestPending && !state.granted) {
        toast('Control request declined. You remain view-only.');
      }
      updateControlUI();
      break;
    }
    case 'control-result':
      if (message.approved !== true) toast('Control request declined. You remain view-only.');
      break;
    case 'frame':
      drawFrame(message);
      break;
    case 'control-denied':
      toast('Input is locked until the host allows control.');
      break;
    case 'session-ended':
      resetToLanding(message.message || 'The host ended the session.');
      break;
    case 'error':
      if (state.connected) toast(message.message || 'Relay error.');
      else setJoinError(message.message || 'Could not join the session.');
      break;
    case 'pong':
      break;
    default:
      break;
  }
}

function connect(code) {
  resetToLanding('');
  state.code = code;
  setJoinError('');
  setJoining(true);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws`;
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    setJoining(false);
    setJoinError('This controller could not open a WebSocket connection.');
    return;
  }
  state.socket = socket;
  socket.addEventListener('open', () => {
    if (state.socket !== socket) return;
    socket.send(JSON.stringify({ type: 'controller-join', code }));
  });
  socket.addEventListener('message', (event) => {
    if (state.socket !== socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch (error) { return; }
    handleMessage(message);
  });
  socket.addEventListener('error', () => {
    if (!state.connected) setJoinError('The relay is unreachable. Check that the Mars Live relay is running.');
  });
  socket.addEventListener('close', () => {
    if (state.socket !== socket || state.resetting) return;
    if (state.connected) {
      resetToLanding('Connection lost. Ask the host for a new session code.');
    } else {
      setJoining(false);
      setJoinError('The relay closed the connection. Check the code and try again.');
    }
  });
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  const sourceRatio = canvas.width / canvas.height;
  const boxRatio = rect.width / rect.height;
  let contentWidth = rect.width;
  let contentHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;
  if (boxRatio > sourceRatio) {
    contentWidth = rect.height * sourceRatio;
    offsetX = (rect.width - contentWidth) / 2;
  } else if (boxRatio < sourceRatio) {
    contentHeight = rect.width / sourceRatio;
    offsetY = (rect.height - contentHeight) / 2;
  }
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left - offsetX) / contentWidth)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top - offsetY) / contentHeight))
  };
}

function sendInput(message) {
  if (!canControl()) return false;
  state.socket.send(JSON.stringify({ type: 'input', ...message }));
  return true;
}

canvas.addEventListener('pointermove', (event) => {
  if (!canControl()) return;
  const now = performance.now();
  if (now - state.lastMoveAt < 32) return;
  state.lastMoveAt = now;
  const point = pointerPosition(event);
  sendInput({ action: 'move', ...point });
});
canvas.addEventListener('pointerdown', (event) => {
  canvas.focus();
  if (!canControl()) return;
  if (!['left', 'right', 'middle'].includes(event.button === 0 ? 'left' : event.button === 2 ? 'right' : event.button === 1 ? 'middle' : '')) return;
  event.preventDefault();
  state.pointerDown = true;
  state.pointerButton = event.button === 0 ? 'left' : event.button === 2 ? 'right' : 'middle';
  try { canvas.setPointerCapture(event.pointerId); } catch (error) {}
  const point = pointerPosition(event);
  sendInput({
    action: 'down', ...point, button: state.pointerButton, clickCount: event.detail || 1,
    altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey
  });
});
function releasePointer(event) {
  if (!state.pointerDown) return;
  const point = pointerPosition(event);
  const button = state.pointerButton;
  state.pointerDown = false;
  sendInput({
    action: 'up', ...point, button, clickCount: 1,
    altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey
  });
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('pointerleave', releasePointer);
canvas.addEventListener('contextmenu', (event) => {
  if (canControl()) event.preventDefault();
});
canvas.addEventListener('wheel', (event) => {
  if (!canControl()) return;
  event.preventDefault();
  const point = pointerPosition(event);
  sendInput({
    action: 'wheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY,
    altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey
  });
}, { passive: false });

function keyMessage(action, event) {
  return {
    action,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    location: event.location,
    text: action === 'key-down' && event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : '',
    repeat: event.repeat,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey
  };
}
canvas.addEventListener('keydown', (event) => {
  if (!canControl()) return;
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'q') {
    event.preventDefault();
    resetToLanding('');
    return;
  }
  event.preventDefault();
  state.pressedKeys.add(`${event.code}:${event.key}`);
  sendInput(keyMessage('key-down', event));
});
canvas.addEventListener('keyup', (event) => {
  if (!canControl()) return;
  event.preventDefault();
  state.pressedKeys.delete(`${event.code}:${event.key}`);
  sendInput(keyMessage('key-up', event));
});
window.addEventListener('blur', () => {
  if (!canControl()) return;
  for (const key of state.pressedKeys) {
    const [code, ...rest] = key.split(':');
    sendInput({ action: 'key-up', key: rest.join(':'), code, keyCode: 0 });
  }
  state.pressedKeys.clear();
});

$('joinForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = $('codeInput').value.replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(code)) {
    setJoinError('Enter the six-digit PIN shown in the host’s Mars Live window.');
    $('codeInput').focus();
    return;
  }
  connect(code);
});
$('codeInput').addEventListener('input', () => {
  $('codeInput').value = $('codeInput').value.replace(/\D/g, '').slice(0, 6);
  setJoinError('');
});
$('requestControlButton').addEventListener('click', () => {
  if (!state.connected || state.granted || state.requestPending) return;
  state.requestPending = true;
  state.socket.send(JSON.stringify({ type: 'request-control' }));
  updateControlUI();
  clearTimeout(state.requestTimer);
  state.requestTimer = setTimeout(() => {
    if (state.requestPending) {
      state.requestPending = false;
      updateControlUI();
      toast('The host did not respond to the control request.');
    }
  }, 12000);
});
$('disconnectButton').addEventListener('click', () => resetToLanding(''));

const linkedPin = (new URLSearchParams(location.search).get('pin') || '').replace(/\D/g, '').slice(0, 6);
if (/^\d{6}$/.test(linkedPin)) {
  $('codeInput').value = linkedPin;
  setTimeout(() => connect(linkedPin), 80);
}

fetch('/api/health', { cache: 'no-store' })
  .then((response) => response.json())
  .then(() => {
    $('relayBadge').classList.remove('offline');
    $('relayBadge').querySelector('span').textContent = 'Relay online';
  })
  .catch(() => {
    $('relayBadge').classList.add('offline');
    $('relayBadge').querySelector('span').textContent = 'Relay offline';
  });
