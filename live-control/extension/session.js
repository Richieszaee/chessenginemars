const $ = (id) => document.getElementById(id);
const state = {
  targetTabId: null,
  targetTitle: '',
  targetUrl: '',
  bridgeUrl: '',
  code: '',
  token: '',
  sharing: false,
  ended: false,
  registered: false,
  bridgeOnline: false,
  controllerConnected: false,
  controlGranted: false,
  paused: false,
  requestPending: false,
  debuggerAttached: false,
  approving: false,
  startedAt: 0,
  sequence: 0,
  stream: null,
  desktopRequestId: 0,
  pollTimer: 0,
  frameTimer: 0,
  durationTimer: 0,
  toastTimer: 0,
  pollInFlight: false,
  frameInFlight: false,
  stateInFlight: false,
  stateDirty: false,
  lastEventId: 0,
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

async function initialize() {
  try {
    const saved = await chrome.storage.local.get('marsLivePending');
    const pending = saved && saved.marsLivePending;
    if (!pending || !Number.isInteger(pending.targetTabId) || !pending.bridgeUrl) {
      setupError('Open Mars Live from the web tab you want to share.');
      return;
    }
    state.targetTabId = pending.targetTabId;
    state.bridgeUrl = pending.bridgeUrl;
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
  pill.classList.toggle('online', state.bridgeOnline);
  pill.classList.toggle('offline', !state.bridgeOnline && state.sharing);
  let text = 'Getting ready';
  if (state.sharing && !state.bridgeOnline) text = 'PHP bridge offline';
  else if (state.sharing && state.controllerConnected) text = 'Controller connected';
  else if (state.sharing) text = 'PHP bridge online · waiting';
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
  if (!state.registered || state.ended || !state.sharing) return;
  if (state.stateInFlight) {
    state.stateDirty = true;
    return;
  }
  state.stateInFlight = true;
  bridgeRequest('state', {
    code: state.code,
    host_token: state.token,
    state: publicState()
  }).catch(() => {
    if (!state.ended) {
      state.bridgeOnline = false;
      render();
    }
  }).finally(() => {
    state.stateInFlight = false;
    if (state.stateDirty) {
      state.stateDirty = false;
      sendHostState();
    }
  });
}

function sendBannerState() {
  if (!state.sharing || state.ended || !state.targetTabId) return;
  chrome.tabs.sendMessage(state.targetTabId, { type: 'mars-live-state', state: publicState() }).catch(() => {});
}

function render() {
  $('pairCode').textContent = state.code || '······';
  $('pairHelp').textContent = state.controllerConnected
    ? 'Controller connected. Sharing is view-only until you allow control.'
    : 'On the other computer, open Mars Live → Join with PIN. Control stays locked until you approve it.';
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
  $('retryRelayButton').hidden = state.bridgeOnline || state.ended;
  $('retryRelayButton').textContent = 'Reconnect bridge';
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

function connectBridge() {
  if (!state.code || state.ended) return;
  state.registered = false;
  state.bridgeOnline = false;
  state.controllerConnected = false;
  state.controlGranted = false;
  state.requestPending = false;
  state.paused = false;
  render();
  bridgeRequest('register', {
    code: state.code,
    host_token: state.token
  }).then(() => {
    if (state.ended) return;
    state.registered = true;
    state.bridgeOnline = true;
    startHostPolling();
    render();
    sendHostState();
    toast('PHP bridge connected. Waiting for the other person to join with the PIN.');
  }).catch(() => {
    if (state.ended) return;
    state.bridgeOnline = false;
    render();
    toast('PHP bridge is unreachable. Check the bridge address, then reconnect.');
  });
}

function handleHostEvent(event) {
  if (!event || typeof event.type !== 'string') return;
  if (event.type === 'controller-joined') {
    state.controllerConnected = true;
    state.controlGranted = false;
    state.requestPending = false;
    state.paused = false;
    broadcastState();
    toast('Controller connected in view-only mode. You decide whether to allow control.');
  } else if (event.type === 'controller-left') {
    state.controllerConnected = false;
    state.controlGranted = false;
    state.requestPending = false;
    state.paused = false;
    detachDebugger().finally(() => {
      broadcastState();
      toast('Controller disconnected. Remote input is off.');
    });
  } else if (event.type === 'request-control') {
    if (!state.controllerConnected || state.controlGranted || state.ended) return;
    state.requestPending = true;
    broadcastState();
    toast('A controller requested mouse and keyboard control.');
  } else if (event.type === 'input') {
    handleInput(event.payload);
  }
}

function hostPoll() {
  if (state.ended || !state.registered || state.pollInFlight) return;
  state.pollInFlight = true;
  bridgeRequest('host_poll', {
    code: state.code,
    host_token: state.token,
    after: state.lastEventId
  }).then((response) => {
    if (state.ended) return;
    state.bridgeOnline = true;
    const remote = response.state || {};
    if (remote.ended) {
      stopSession('The PHP bridge closed this session.');
      return;
    }
    const wasConnected = state.controllerConnected;
    state.controllerConnected = remote.controllerConnected === true;
    if (wasConnected && !state.controllerConnected) {
      state.controlGranted = false;
      state.requestPending = false;
      state.paused = false;
      detachDebugger().finally(() => broadcastState());
    }
    const events = Array.isArray(response.events) ? response.events : [];
    for (const event of events) {
      if (Number.isInteger(event.id) && event.id > state.lastEventId) state.lastEventId = event.id;
      handleHostEvent(event);
    }
    render();
    sendBannerState();
  }).catch(() => {
    if (state.ended) return;
    state.bridgeOnline = false;
    state.controllerConnected = false;
    state.controlGranted = false;
    state.requestPending = false;
    state.paused = false;
    detachDebugger().finally(() => {
      broadcastState();
      toast('PHP bridge connection lost. Remote control is off until you reconnect.');
    });
  }).finally(() => {
    state.pollInFlight = false;
  });
}

function startHostPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(hostPoll, 500);
  hostPoll();
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
    broadcastState();
    bridgeRequest('control', { code: state.code, host_token: state.token, grant: true }).catch(() => {});
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
  broadcastState();
  bridgeRequest('control', { code: state.code, host_token: state.token, grant: false }).catch(() => {});
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
  bridgeRequest('control', { code: state.code, host_token: state.token, grant: false }).catch(() => {});
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
  state.frameTimer = setInterval(sendFrame, 200);
  state.durationTimer = setInterval(updateDuration, 1000);
}

function updateDuration() {
  if (!state.startedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  $('duration').textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function sendFrame() {
  if (state.ended || !state.controllerConnected || !state.registered || state.frameInFlight) return;
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return;
  const scale = Math.min(1, 1280 / video.videoWidth);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.drawImage(video, 0, 0, width, height);
  let data;
  try { data = canvas.toDataURL('image/jpeg', 0.58); } catch (error) { return; }
  state.frameInFlight = true;
  bridgeRequest('frame', {
    code: state.code,
    host_token: state.token,
    sequence: ++state.sequence,
    width,
    height,
    data
  }).catch(() => {
    if (!state.ended) {
      state.bridgeOnline = false;
      render();
    }
  }).finally(() => {
    state.frameInFlight = false;
  });
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
        bridgeUrl: state.bridgeUrl
      }
    });
  } catch (error) {
    // The visible session window is still a reliable stop control.
  }
}

// chooseDesktopMedia() returns a cancel id synchronously and only ever hands
// the real stream id to its callback, so it must be wrapped in a Promise.
//
// targetTab is deliberately NOT passed. Per the Chrome docs, passing it makes
// the stream usable only "by frames in the given tab" — and session.html is an
// extension page, not a frame in the shared tab, so capture aborts with
// "Error starting tab capture". Omitting it makes the stream available to "the
// calling extension", which is what we are.
function chooseTabStream() {
  return new Promise((resolve, reject) => {
    try {
      state.desktopRequestId = chrome.desktopCapture.chooseDesktopMedia(['tab'], resolve);
    } catch (error) {
      reject(error);
    }
  });
}

async function startSharing() {
  if (state.sharing || state.ended) return;
  setupError('');
  $('shareButton').disabled = true;
  $('shareLabel').textContent = 'Waiting for Chrome…';
  let stream = null;
  try {
    const streamId = await chooseTabStream();
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
    connectBridge();
    startFrameLoop();
    render();
    toast('Tab shared. Send the bridge address and PIN to someone you trust.');
  } catch (error) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    state.sharing = false;
    state.startedAt = 0;
    state.code = '';
    state.token = '';
    showView('setup');
    const name = (error && error.name) || '';
    console.warn('Mars Live share failed:', name, error && error.message);
    const denied = name === 'NotAllowedError' || name === 'PermissionDeniedError';
    const busy = name === 'NotReadableError' || name === 'TrackStartError';
    const aborted = name === 'AbortError';
    setupError(denied
      ? 'Chrome did not grant screen access. Nothing was captured. Try again when you are ready.'
      : aborted
        ? 'Chrome could not start capturing that tab. Pick a different tab, or reload the tab and try again.'
        : busy
          ? 'That tab is already being captured. Stop the other share (or close the other Mars Live window) and try again.'
          : `The tab could not be shared${name ? ` (${name})` : ''}. Close any existing capture of this tab and try again.`);
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
  clearInterval(state.pollTimer);
  clearInterval(state.frameTimer);
  clearInterval(state.durationTimer);
  if (state.desktopRequestId) {
    try { chrome.desktopCapture.cancelChooseDesktopMedia(state.desktopRequestId); } catch (error) {}
    state.desktopRequestId = 0;
  }
  if (state.registered && state.code) {
    bridgeRequest('end', { code: state.code, host_token: state.token }, true).catch(() => {});
  }
  state.registered = false;
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
    toast('PIN copied.');
  } catch (error) {
    const input = document.createElement('textarea');
    input.value = state.code;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    toast('PIN copied.');
  }
});
$('allowControlButton').addEventListener('click', approveControl);
$('declineControlButton').addEventListener('click', declineControl);
$('pauseControlButton').addEventListener('click', togglePause);
$('revokeControlButton').addEventListener('click', revokeControl);
$('retryRelayButton').addEventListener('click', connectBridge);
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
