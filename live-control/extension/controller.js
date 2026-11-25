const $ = (id) => document.getElementById(id);
const state = {
  bridgeUrl: '',
  code: '',
  token: '',
  active: false,
  connected: false,
  hostConnected: false,
  granted: false,
  paused: false,
  requestPending: false,
  pollTimer: 0,
  pollInFlight: false,
  after: 0,
  afterFrame: 0,
  lastFrameSequence: 0,
  hasFrame: false,
  hostTitle: '',
  requestTimer: 0,
  toastTimer: 0,
  lastMoveAt: 0,
  pointerDown: false,
  pointerButton: 'left',
  pressedKeys: new Set(),
  errorShown: false
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
  $('joinButton').textContent = joining ? 'Connecting…' : 'Connect';
  $('bridgeUrl').disabled = joining;
  $('pinInput').disabled = joining;
}

function parseBridge(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/bridge.php';
    url.hash = '';
    return url;
  } catch (error) {
    return null;
  }
}

async function bridgeRequest(action, payload = {}, keepalive = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), keepalive ? 2000 : 8000);
  try {
    const response = await fetch(state.bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
      cache: 'no-store',
      keepalive,
      signal: controller.signal
    });
    let data = null;
    try { data = await response.json(); } catch (error) {}
    if (!response.ok || !data || data.ok !== true) {
      throw new Error(data && data.message ? data.message : 'PHP bridge request failed.');
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function canControl() {
  return state.active && state.connected && state.hostConnected && state.granted && !state.paused;
}

function updateConnection() {
  const pill = $('connectionPill');
  pill.classList.toggle('online', state.connected && state.hostConnected);
  pill.classList.toggle('offline', !state.connected || !state.hostConnected);
  pill.querySelector('span').textContent = !state.active
    ? 'Not connected'
    : !state.connected
      ? 'Bridge offline'
      : !state.hostConnected
        ? 'Host offline'
        : 'Connected';
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
  $('requestControlButton').hidden = state.granted;
  $('requestControlButton').disabled = state.requestPending || !state.connected || !state.hostConnected;
  $('requestControlButton').textContent = state.requestPending ? 'Waiting for approval…' : 'Request control';
  $('inputHint').textContent = live ? 'INPUT LIVE · CLICK SCREEN TO FOCUS' : 'INPUT LOCKED BY HOST';
  $('screenMeta').textContent = state.hasFrame
    ? `${canvas.width} × ${canvas.height}`
    : live ? 'CONTROL LIVE' : 'VIEW ONLY';
  canvas.classList.toggle('control-live', live);
  updateConnection();
}

function showLive() {
  $('liveView').hidden = false;
  $('setupView').hidden = true;
  $('hostTitle').textContent = state.hostTitle || 'Connected to a tab';
  $('screenWaiting').hidden = state.hasFrame;
  updateControlUI();
}

function drawFrame(frame) {
  if (!frame || !Number.isInteger(frame.sequence) || frame.sequence <= state.lastFrameSequence) return;
  if (typeof frame.data !== 'string' || !frame.data.startsWith('data:image/jpeg;base64,')) return;
  state.lastFrameSequence = frame.sequence;
  state.afterFrame = frame.sequence;
  const image = new Image();
  image.onload = () => {
    if (!state.active) return;
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.drawImage(image, 0, 0);
    state.hasFrame = true;
    $('screenWaiting').hidden = true;
    updateControlUI();
  };
  image.src = frame.data;
}

function applyRemoteState(remote) {
  const wasGranted = state.granted;
  state.connected = true;
  state.hostConnected = remote.hostConnected === true;
  state.granted = remote.controlGranted === true;
  state.paused = state.granted && remote.paused === true;
  state.requestPending = remote.requestPending === true;
  if (remote.targetTitle) state.hostTitle = remote.targetTitle;
  if (state.granted && !wasGranted) {
    toast('Control approved. Click the screen to send mouse and keyboard input.');
    canvas.focus();
  } else if (wasGranted && !state.granted) {
    state.pressedKeys.clear();
    toast('Control revoked by the host. You are view-only again.');
  }
  updateControlUI();
}

function handleEvents(events) {
  for (const event of events || []) {
    if (Number.isInteger(event.id) && event.id > state.after) state.after = event.id;
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'control-result' && (!event.payload || event.payload.approved !== true)) {
      state.requestPending = false;
      updateControlUI();
      toast('Control request declined. You remain view-only.');
    } else if (event.type === 'session-ended') {
      endController(event.payload && event.payload.message ? event.payload.message : 'The host ended the session.');
      return;
    }
  }
}

async function poll() {
  if (!state.active || !state.token || state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const response = await bridgeRequest('controller_poll', {
      code: state.code,
      controller_token: state.token,
      after: state.after,
      after_frame: state.afterFrame
    });
    if (!state.active) return;
    if (response.state && response.state.ended) {
      endController('The host ended the session.');
      return;
    }
    applyRemoteState(response.state || {});
    handleEvents(response.events);
    if (response.frame) drawFrame(response.frame);
    state.errorShown = false;
  } catch (error) {
    if (state.active && !state.errorShown) {
      state.errorShown = true;
      state.connected = false;
      updateConnection();
      toast('PHP bridge connection lost. Waiting for it to come back.');
    }
  } finally {
    state.pollInFlight = false;
  }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(poll, 300);
  poll();
}

async function join() {
  const bridge = parseBridge($('bridgeUrl').value.trim());
  const code = $('pinInput').value.replace(/\D/g, '').slice(0, 6);
  if (!bridge) {
    setJoinError('Enter the HTTP or HTTPS address of bridge.php.');
    $('bridgeUrl').focus();
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    setJoinError('Enter the six-digit PIN from the host.');
    $('pinInput').focus();
    return;
  }
  setJoinError('');
  setJoining(true);
  state.bridgeUrl = bridge.href;
  state.code = code;
  try {
    const response = await bridgeRequest('join', { code });
    state.token = response.controller_token;
    state.active = true;
    state.connected = true;
    state.hostConnected = true;
    state.granted = false;
    state.paused = false;
    state.requestPending = false;
    state.after = 0;
    state.afterFrame = 0;
    state.lastFrameSequence = 0;
    state.hasFrame = false;
    state.errorShown = false;
    applyRemoteState(response.state || {});
    chrome.storage.local.set({ marsLiveBridgeUrl: state.bridgeUrl }).catch(() => {});
    showLive();
    startPolling();
  } catch (error) {
    state.active = false;
    setJoinError(error.message || 'Could not join the session.');
  } finally {
    setJoining(false);
  }
}

function endController(message) {
  if (!state.active && !state.token) return;
  state.active = false;
  clearInterval(state.pollTimer);
  clearTimeout(state.requestTimer);
  if (state.token) {
    bridgeRequest('leave', { code: state.code, controller_token: state.token }, true).catch(() => {});
  }
  state.token = '';
  state.connected = false;
  state.hostConnected = false;
  state.granted = false;
  state.paused = false;
  state.requestPending = false;
  state.hasFrame = false;
  state.after = 0;
  state.afterFrame = 0;
  state.lastFrameSequence = 0;
  state.pressedKeys.clear();
  state.pointerDown = false;
  $('liveView').hidden = true;
  $('setupView').hidden = false;
  setJoinError(message || '');
  updateConnection();
  updateControlUI();
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
  bridgeRequest('input', { code: state.code, controller_token: state.token, input: message }).catch(() => {});
  return true;
}

canvas.addEventListener('pointermove', (event) => {
  if (!canControl()) return;
  const now = performance.now();
  if (now - state.lastMoveAt < 35) return;
  state.lastMoveAt = now;
  sendInput({ action: 'move', ...pointerPosition(event) });
});
canvas.addEventListener('pointerdown', (event) => {
  canvas.focus();
  if (!canControl()) return;
  const button = event.button === 0 ? 'left' : event.button === 2 ? 'right' : event.button === 1 ? 'middle' : '';
  if (!button) return;
  event.preventDefault();
  state.pointerDown = true;
  state.pointerButton = button;
  try { canvas.setPointerCapture(event.pointerId); } catch (error) {}
  sendInput({
    action: 'down', ...pointerPosition(event), button, clickCount: event.detail || 1,
    altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey
  });
});
function releasePointer(event) {
  if (!state.pointerDown) return;
  const button = state.pointerButton;
  state.pointerDown = false;
  sendInput({
    action: 'up', ...pointerPosition(event), button, clickCount: 1,
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
  sendInput({
    action: 'wheel', ...pointerPosition(event), deltaX: event.deltaX, deltaY: event.deltaY,
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
  join();
});
$('pinInput').addEventListener('input', () => {
  $('pinInput').value = $('pinInput').value.replace(/\D/g, '').slice(0, 6);
  setJoinError('');
});
$('requestControlButton').addEventListener('click', () => {
  if (!state.active || state.granted || state.requestPending) return;
  state.requestPending = true;
  updateControlUI();
  bridgeRequest('request_control', { code: state.code, controller_token: state.token }).then((response) => {
    if (state.active && response.state) applyRemoteState(response.state);
  }).catch(() => {
    if (!state.active) return;
    state.requestPending = false;
    updateControlUI();
    toast('The control request could not be sent.');
  });
  clearTimeout(state.requestTimer);
  state.requestTimer = setTimeout(() => {
    if (state.active && state.requestPending) {
      state.requestPending = false;
      updateControlUI();
      toast('The host did not respond to the control request.');
    }
  }, 12000);
});
$('disconnectButton').addEventListener('click', () => endController(''));

async function loadSettings() {
  try {
    const saved = await chrome.storage.local.get(['marsLiveBridgeUrl', 'marsLiveRelayUrl']);
    if (saved.marsLiveBridgeUrl) {
      $('bridgeUrl').value = saved.marsLiveBridgeUrl;
    } else if (saved.marsLiveRelayUrl) {
      try {
        const old = new URL(saved.marsLiveRelayUrl);
        old.protocol = old.protocol === 'wss:' ? 'https:' : 'http:';
        old.pathname = '/bridge.php';
        old.hash = '';
        $('bridgeUrl').value = old.href;
      } catch (error) {}
    }
    const linkedPin = (new URLSearchParams(location.search).get('pin') || '').replace(/\D/g, '').slice(0, 6);
    if (/^\d{6}$/.test(linkedPin)) $('pinInput').value = linkedPin;
  } catch (error) {
    // The form remains usable with manual input.
  }
}

window.addEventListener('beforeunload', () => {
  if (state.active && state.token) {
    bridgeRequest('leave', { code: state.code, controller_token: state.token }, true).catch(() => {});
  }
});

loadSettings();
updateConnection();
updateControlUI();
