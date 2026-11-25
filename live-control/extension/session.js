const $ = (id) => document.getElementById(id);
const state = {
  targetTabId: null,
  targetTitle: '',
  targetUrl: '',
  relayUrl: '',
  code: '',
  token: '',
  sharing: false,
  ended: false,
  relayOnline: false,
  controllerConnected: false,
  controlGranted: false,
  paused: false,
  requestPending: false,
  debuggerAttached: false,
  approving: false,
  startedAt: 0,
  sequence: 0,
  stream: null,
  socket: null,
  frameTimer: 0,
  durationTimer: 0,
  toastTimer: 0,
  inputQueue: Promise.resolve(),
  queuedInputs: 0,
  inputErrorShown: false,
  viewport: { width: 0, height: 0 },
  viewportAt: 0
};
const video = $('preview');
const canvas = $('captureCanvas');
const ctx = canvas.getContext('2d', { alpha: false });

function toast(message) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600);
}

function showView(name) {
  $('setupView').hidden = name !== 'setup';
  $('liveView').hidden = name !== 'live';
  $('endedView').hidden = name !== 'ended';
}

function setupError(message) {
  $('setupError').textContent = message || '';
  $('setupError').hidden = !message;
  $('shareButton').disabled = !state.targetTabId || !!message;
  $('shareLabel').textContent = state.targetTabId ? 'Choose tab & share' : 'Tab unavailable';
}

function randomCode() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return String(value[0] % 1000000).padStart(6, '0');
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function controllerWebsiteUrl() {
  try {
    const relay = new URL(state.relayUrl);
    relay.protocol = relay.protocol === 'wss:' ? 'https:' : 'http:';
    relay.pathname = '/connect';
    relay.hash = '';
    relay.search = '';
    if (state.code) relay.searchParams.set('pin', state.code);
    return relay.href;
  } catch (error) {
    return '';
  }
}

async function initialize() {
  try {
    const saved = await chrome.storage.local.get('marsLivePending');
    const pending = saved && saved.marsLivePending;
    if (!pending || !Number.isInteger(pending.targetTabId) || !pending.relayUrl) {
      setupError('Open Mars Live from the web tab you want to share.');
      return;
    }
    state.targetTabId = pending.targetTabId;
    state.relayUrl = pending.relayUrl;
    await chrome.storage.local.remove('marsLivePending');

    const tab = await chrome.tabs.get(state.targetTabId);
    state.targetTitle = tab.title || 'Untitled web tab';
    state.targetUrl = tab.url || '';
    $('targetTitle').textContent = state.targetTitle;
    $('targetUrl').textContent = state.targetUrl;
    if (!/^https?:\/\//i.test(state.targetUrl)) {
      setupError('This tab cannot be shared. Open Mars Live on a regular web tab.');
      return;
    }
    setupError('');
  } catch (error) {
    setupError('The target tab is no longer available. Reopen Mars Live from the tab you want to share.');
  }
}

function setConnectionPill() {
  const pill = $('connectionPill');
  pill.classList.toggle('online', state.relayOnline);
  pill.classList.toggle('offline', !state.relayOnline && state.sharing);
  let text = 'Getting ready';
  if (state.sharing && !state.relayOnline) text = 'Relay offline';
  else if (state.sharing && state.controllerConnected) text = 'Controller connected';
  else if (state.sharing) text = 'Relay online · waiting';
  else if (state.ended) text = 'Session closed';
  pill.querySelector('span').textContent = text;
}

function publicState() {
  return {
    sharing: state.sharing,
    controllerConnected: state.controllerConnected,
    controlGranted: state.controlGranted,
    paused: state.paused,
    requestPending: state.requestPending,
    targetTitle: state.targetTitle
  };
}

function sendHostState() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.relayOnline || state.ended) return;
  state.socket.send(JSON.stringify({
    type: 'host-state',
    ...publicState()
  }));
}

function sendBannerState() {
  if (!state.sharing || state.ended || !state.targetTabId) return;
  chrome.tabs.sendMessage(state.targetTabId, { type: 'mars-live-state', state: publicState() }).catch(() => {});
}

function render() {
  $('pairCode').textContent = state.code || '······';
  $('openControllerButton').disabled = !state.code || !controllerWebsiteUrl();
  $('pairHelp').textContent = state.controllerConnected
    ? 'Controller connected. Sharing is view-only until you allow control.'
    : 'Open the controller page and enter this code. Control is still locked until you approve it.';
  $('controllerStatus').textContent = state.requestPending
    ? 'Control requested'
    : state.controlGranted
      ? (state.paused ? 'Control paused' : 'Control approved')
      : state.controllerConnected ? 'Controller viewing' : 'Waiting for controller';
  $('controllerDot').className = state.controlGranted ? 'granted' : state.controllerConnected ? 'connected' : '';
  $('controlBadge').textContent = state.requestPending
    ? 'APPROVAL NEEDED'
    : state.controlGranted
      ? (state.paused ? 'PAUSED' : 'CONTROL LIVE')
      : state.controllerConnected ? 'VIEW ONLY' : 'NO CONTROLLER';
  $('controlBadge').className = `control-badge ${state.requestPending ? 'waiting' : state.controlGranted && !state.paused ? 'live' : ''}`;
  $('requestPanel').hidden = !state.requestPending;
  $('activePanel').hidden = state.requestPending;
  $('pauseControlButton').hidden = !state.controlGranted;
  $('pauseControlButton').textContent = state.paused ? 'Resume control' : 'Pause control';
  $('revokeControlButton').hidden = !state.controlGranted;
  $('retryRelayButton').hidden = state.relayOnline || state.ended;
  $('controlDescription').textContent = state.controlGranted
    ? state.paused
      ? 'The controller can still see this tab, but mouse and keyboard input is paused.'
      : 'Mouse and keyboard input is live. Your local mouse still works normally.'
    : state.controllerConnected
      ? 'The controller can see this tab only. No mouse or keyboard input is accepted yet.'
      : 'The controller can request access at any time. You can revoke it below.';
  $('allowControlButton').disabled = state.approving;
  $('allowControlButton').textContent = state.approving ? 'Approving…' : 'Allow control';
  setConnectionPill();
}

function broadcastState() {
  render();
  sendHostState();
  sendBannerState();
}

async function injectBanner() {
  if (!state.targetTabId || state.ended) return false;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: state.targetTabId },
      files: ['banner.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId: state.targetTabId },
      files: ['banner.js']
    });
    sendBannerState();
    return true;
  } catch (error) {
    toast('The live banner could not be shown on this tab. Keep this window open to stop the session.');
    return false;
  }
}

async function attachDebugger() {
  if (state.debuggerAttached || state.ended) return;
  await chrome.debugger.attach({ tabId: state.targetTabId }, '1.3');
  state.debuggerAttached = true;
  state.inputErrorShown = false;
}

async function detachDebugger() {
  if (!state.debuggerAttached) return;
  try {
    await chrome.debugger.detach({ tabId: state.targetTabId });
  } catch (error) {
    // Chrome may already have detached when the tab closed or navigated.
  }
  state.debuggerAttached = false;
}

function connectRelay() {
  if (!state.code || state.ended) return;
  if (state.socket) {
    state.socket.onclose = null;
    try { state.socket.close(); } catch (error) {}
    state.socket = null;
  }
  state.relayOnline = false;
  state.controllerConnected = false;
  state.controlGranted = false;
  state.requestPending = false;
  state.paused = false;
  render();
  let socket;
  try {
    socket = new WebSocket(state.relayUrl);
  } catch (error) {
    toast('The relay URL is not valid. Start a new session to change it.');
    return;
  }
  state.socket = socket;
  socket.addEventListener('open', () => {
    if (state.socket !== socket || state.ended) return;
    socket.send(JSON.stringify({ type: 'host-register', code: state.code, token: state.token }));
  });
  socket.addEventListener('message', (event) => {
    if (state.socket !== socket || state.ended) return;
    let message;
    try { message = JSON.parse(event.data); } catch (error) { return; }
    handleRelayMessage(message);
  });
  socket.addEventListener('close', () => {
    if (state.socket !== socket || state.ended) return;
    state.socket = null;
    state.relayOnline = false;
    state.controllerConnected = false;
    state.controlGranted = false;
    state.requestPending = false;
    state.paused = false;
    detachDebugger().finally(() => {
      broadcastState();
      if (state.sharing) toast('Relay disconnected. Remote control is off until you reconnect.');
    });
  });
}

function handleRelayMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'host-ready':
      state.relayOnline = true;
      render();
      sendHostState();
      break;
    case 'controller-joined':
      state.controllerConnected = true;
      state.controlGranted = false;
      state.requestPending = false;
      state.paused = false;
      broadcastState();
      toast('Controller connected in view-only mode. You decide whether to allow control.');
      break;
    case 'controller-left':
      state.controllerConnected = false;
      state.controlGranted = false;
      state.requestPending = false;
      state.paused = false;
      detachDebugger().finally(() => {
        broadcastState();
        toast('Controller disconnected. Remote input is off.');
      });
      break;
    case 'request-control':
      if (!state.controllerConnected || state.controlGranted || state.ended) return;
      state.requestPending = true;
      broadcastState();
      toast('A controller requested mouse and keyboard control.');
      break;
    case 'input':
      handleInput(message);
      break;
    case 'control-result':
      // The controller receives these; ignore any accidental echo.
      break;
    case 'error':
      if (message.code === 'code-in-use') toast('This pairing code is already in use. Stop and start a new session.');
      else if (message.message) toast(String(message.message).slice(0, 160));
      break;
    default:
      break;
  }
}

async function approveControl() {
  if (!state.controllerConnected || state.ended || state.approving) return;
  state.approving = true;
  render();
  try {
    await attachDebugger();
    state.controlGranted = true;
    state.paused = false;
    state.requestPending = false;
    state.inputErrorShown = false;
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: 'control-result', approved: true }));
    }
    broadcastState();
    toast('Control approved. The controller can now use the mouse and keyboard in this tab.');
  } catch (error) {
    state.controlGranted = false;
    state.requestPending = false;
    state.paused = false;
    broadcastState();
    toast('Chrome could not enable control. Close any other debugger attached to this tab and try again.');
  } finally {
    state.approving = false;
    render();
  }
}

function declineControl() {
  state.requestPending = false;
  state.controlGranted = false;
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'control-result', approved: false }));
  }
  broadcastState();
  toast('Control request declined. The controller remains view-only.');
}

function togglePause() {
  if (!state.controlGranted) return;
  state.paused = !state.paused;
  if (!state.paused) state.inputErrorShown = false;
  broadcastState();
  toast(state.paused ? 'Remote control paused. Your local mouse still works.' : 'Remote control resumed.');
}

async function revokeControl() {
  state.controlGranted = false;
  state.paused = false;
  state.requestPending = false;
  await detachDebugger();
  broadcastState();
  toast('Remote control revoked. The controller is view-only again.');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalized(value) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : null;
}

function modifierBits(message) {
  let modifiers = 0;
  if (message.altKey) modifiers |= 1;
  if (message.ctrlKey) modifiers |= 2;
  if (message.metaKey) modifiers |= 4;
  if (message.shiftKey) modifiers |= 8;
  return modifiers;
}

async function getViewport() {
  if (state.viewport.width && Date.now() - state.viewportAt < 1000) return state.viewport;
  const result = await chrome.debugger.sendCommand({ tabId: state.targetTabId }, 'Page.getLayoutMetrics');
  const viewport = [result.cssVisualViewport, result.cssLayoutViewport, result.visualViewport, result.layoutViewport]
    .find((candidate) => candidate && candidate.clientWidth > 0 && candidate.clientHeight > 0);
  if (viewport) {
    state.viewport = { width: viewport.clientWidth, height: viewport.clientHeight };
    state.viewportAt = Date.now();
  }
  return state.viewport;
}

async function dispatchInput(message) {
  if (!state.controlGranted || state.paused || !state.debuggerAttached || state.ended) return;
  const action = message.action;
  const x = normalized(message.x);
  const y = normalized(message.y);
  const viewport = await getViewport();
  if (!viewport.width || !viewport.height) return;
  const px = x === null ? 0 : x * viewport.width;
  const py = y === null ? 0 : y * viewport.height;

  if (action === 'move' && x !== null && y !== null) {
    await chrome.debugger.sendCommand({ tabId: state.targetTabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: px, y: py, button: 'none', pointerType: 'mouse'
    });
  } else if ((action === 'down' || action === 'up') && x !== null && y !== null) {
    const button = ['left', 'right', 'middle'].includes(message.button) ? message.button : 'left';
    await chrome.debugger.sendCommand({ tabId: state.targetTabId }, 'Input.dispatchMouseEvent', {
      type: action === 'down' ? 'mousePressed' : 'mouseReleased',
      x: px, y: py, button, clickCount: clamp(Math.round(message.clickCount) || 1, 1, 3),
      modifiers: modifierBits(message), pointerType: 'mouse'
    });
  } else if (action === 'wheel' && x !== null && y !== null) {
    await chrome.debugger.sendCommand({ tabId: state.targetTabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: px, y: py,
      deltaX: clamp(Number(message.deltaX) || 0, -1000, 1000),
      deltaY: clamp(Number(message.deltaY) || 0, -1000, 1000),
      modifiers: modifierBits(message), pointerType: 'mouse'
    });
  } else if (action === 'key-down' || action === 'key-up') {
    const key = typeof message.key === 'string' ? message.key.slice(0, 50) : '';
    const code = typeof message.code === 'string' ? message.code.slice(0, 50) : '';
    if (!key && !code) return;
    const text = typeof message.text === 'string' && message.text.length <= 4 ? message.text : '';
    const keyCode = clamp(Math.round(Number(message.keyCode) || 0), 0, 255);
    await chrome.debugger.sendCommand({ tabId: state.targetTabId }, 'Input.dispatchKeyEvent', {
      type: action === 'key-up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
      key, code, text: action === 'key-down' ? text : '',
      unformattedText: action === 'key-down' ? text : '',
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      autoRepeat: action === 'key-down' && message.repeat === true,
      isKeypad: message.location === 3,
      modifiers: modifierBits(message)
    });
  }
}

function handleInput(message) {
  if (!state.controlGranted || state.paused || !state.debuggerAttached || state.ended) return;
  if (state.queuedInputs > 70) return;
  state.queuedInputs += 1;
  state.inputQueue = state.inputQueue.then(async () => {
    try {
      await dispatchInput(message);
    } catch (error) {
      if (!state.inputErrorShown && !state.ended) {
        state.inputErrorShown = true;
        state.controlGranted = false;
        state.paused = false;
        broadcastState();
        toast('Remote input stopped because Chrome detached from the tab. Review the session before allowing control again.');
      }
    } finally {
      state.queuedInputs -= 1;
    }
  });
}

function startFrameLoop() {
  clearInterval(state.frameTimer);
  clearInterval(state.durationTimer);
  state.frameTimer = setInterval(sendFrame, 125);
  state.durationTimer = setInterval(updateDuration, 1000);
}

function updateDuration() {
  if (!state.startedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  $('duration').textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function sendFrame() {
  if (state.ended || !state.controllerConnected || !state.relayOnline || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return;
  if (state.socket.bufferedAmount > 1500000) return;
  const scale = Math.min(1, 1280 / video.videoWidth);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.drawImage(video, 0, 0, width, height);
  let data;
  try { data = canvas.toDataURL('image/jpeg', 0.62); } catch (error) { return; }
  state.socket.send(JSON.stringify({
    type: 'frame',
    sequence: ++state.sequence,
    width,
    height,
    data
  }));
  $('previewResolution').textContent = `${video.videoWidth} × ${video.videoHeight}`;
}

async function persistSession() {
  try {
    const current = await chrome.windows.getCurrent();
    await chrome.storage.local.set({
      marsLiveSession: {
        windowId: current.id,
        targetTabId: state.targetTabId,
        startedAt: state.startedAt,
        code: state.code,
        relayUrl: state.relayUrl
      }
    });
  } catch (error) {
    // The visible session window is still a reliable stop control.
  }
}

async function startSharing() {
  if (state.sharing || state.ended) return;
  setupError('');
  $('shareButton').disabled = true;
  $('shareLabel').textContent = 'Waiting for Chrome…';
  let stream = null;
  try {
    const streamId = await chrome.desktopCapture.chooseDesktopMedia(['tab'], state.targetTabId);
    if (!streamId) {
      setupError('Sharing was canceled. Nothing was captured.');
      return;
    }
    state.code = randomCode();
    state.token = randomToken();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId,
          maxFrameRate: 15
        }
      }
    });
    state.stream = stream;
    state.sharing = true;
    state.startedAt = Date.now();
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => stopSession('Chrome ended screen sharing. Remote control was disabled.'));

    showView('live');
    await injectBanner();
    await persistSession();
    connectRelay();
    startFrameLoop();
    render();
    toast('Tab shared. Share the pairing code with someone you trust.');
  } catch (error) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    state.sharing = false;
    state.startedAt = 0;
    state.code = '';
    state.token = '';
    showView('setup');
    const denied = error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError');
    setupError(denied
      ? 'Chrome did not grant screen access. Nothing was captured. Try again when you are ready.'
      : 'The tab could not be shared. Close any existing capture of this tab and try again.');
  } finally {
    $('shareButton').disabled = false;
    $('shareLabel').textContent = 'Choose tab & share';
  }
}

async function stopSession(reason) {
  if (state.ended) return;
  state.ended = true;
  state.sharing = false;
  state.controlGranted = false;
  state.controllerConnected = false;
  state.requestPending = false;
  state.paused = false;
  clearInterval(state.frameTimer);
  clearInterval(state.durationTimer);
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    try {
      state.socket.send(JSON.stringify({ type: 'host-end', token: state.token }));
    } catch (error) {}
    setTimeout(() => { try { state.socket.close(); } catch (error) {} }, 30);
  }
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  video.srcObject = null;
  try {
    await chrome.tabs.sendMessage(state.targetTabId, { type: 'mars-live-ended' });
  } catch (error) {}
  await detachDebugger();
  try { await chrome.storage.local.remove('marsLiveSession'); } catch (error) {}
  $('endedReason').textContent = reason || 'Sharing stopped and the controller was disconnected.';
  showView('ended');
  setConnectionPill();
}

$('shareButton').addEventListener('click', startSharing);
$('copyCode').addEventListener('click', async () => {
  if (!state.code) return;
  try {
    await navigator.clipboard.writeText(state.code);
    toast('Pairing code copied.');
  } catch (error) {
    const input = document.createElement('textarea');
    input.value = state.code;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    toast('Pairing code copied.');
  }
});
$('openControllerButton').addEventListener('click', () => {
  const url = controllerWebsiteUrl();
  if (url) chrome.tabs.create({ url });
});
$('allowControlButton').addEventListener('click', approveControl);
$('declineControlButton').addEventListener('click', declineControl);
$('pauseControlButton').addEventListener('click', togglePause);
$('revokeControlButton').addEventListener('click', revokeControl);
$('retryRelayButton').addEventListener('click', connectRelay);
$('stopButton').addEventListener('click', () => stopSession('Sharing stopped and the controller was disconnected.'));
$('closeSessionButton').addEventListener('click', async () => {
  const current = await chrome.windows.getCurrent();
  await chrome.windows.remove(current.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id || !message || message.type !== 'mars-live-action') return false;
  if (message.action === 'stop') stopSession('Stopped from the live tab banner. The controller was disconnected.');
  else if (message.action === 'pause') togglePause();
  else if (message.action === 'allow') approveControl();
  else if (message.action === 'decline') declineControl();
  sendResponse({ ok: true });
  return false;
});

chrome.debugger.onDetach.addListener((source) => {
  if (!source || source.tabId !== state.targetTabId || state.ended) return;
  state.debuggerAttached = false;
  if (state.controlGranted) {
    state.controlGranted = false;
    state.paused = false;
    broadcastState();
    toast('Chrome detached remote input. You must allow control again to resume.');
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.targetTabId && state.sharing) stopSession('The shared tab was closed. Capture and remote control stopped.');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== state.targetTabId || !state.sharing || state.ended || changeInfo.status !== 'complete') return;
  injectBanner();
});

window.addEventListener('beforeunload', () => {
  if (state.sharing) stopSession('The session window was closed. Capture and remote control stopped.');
});

initialize();
