const $ = (id) => document.getElementById(id);
const state = {
  pinned: false,
  pinDetectionSupported: true,
  manualPinned: false,
  tab: null,
  bridgeUrl: 'http://127.0.0.1:8080/bridge.php',
  existingSession: null,
  loading: true,
  starting: false
};

function showError(message) {
  $('errorMessage').textContent = message || '';
  $('errorMessage').hidden = !message;
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

function bridgeLabel(value) {
  const url = parseBridge(value);
  if (!url) return 'Invalid address';
  return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ? 'Local PHP' : url.host;
}

async function checkPin() {
  state.pinDetectionSupported = !!(chrome.action && chrome.action.getUserSettings);
  if (state.pinDetectionSupported) {
    try {
      const settings = await chrome.action.getUserSettings();
      state.pinned = settings.isOnToolbar === true;
    } catch (error) {
      state.pinDetectionSupported = false;
      state.pinned = state.manualPinned;
    }
  } else {
    state.pinned = state.manualPinned;
  }
}

async function loadTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tabs && tabs[0] ? tabs[0] : null;
}

function flash(button, label) {
  const original = button.querySelector('span') ? button.querySelector('span').textContent : button.textContent;
  if (button.querySelector('span')) button.querySelector('span').textContent = label;
  else button.textContent = label;
  setTimeout(() => {
    if (button.querySelector('span')) button.querySelector('span').textContent = original;
    else button.textContent = original;
  }, 1200);
}

async function copyText(text, button, successLabel) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  if (button && successLabel) flash(button, successLabel);
}

function inviteText() {
  const session = state.existingSession;
  if (!session || !session.code) return '';
  return [
    'Mars Live invite',
    `Bridge: ${session.bridgeUrl || state.bridgeUrl}`,
    `PIN: ${session.code}`,
    'On the other computer: open Mars Live → Join with PIN.'
  ].join('\n');
}

function render() {
  const active = !!state.existingSession;
  $('connectView').hidden = active;
  $('sessionView').hidden = !active;

  const url = state.tab && state.tab.url ? state.tab.url : '';
  const supported = /^https?:\/\//i.test(url) && !/^https:\/\/chromewebstore\.google\.com\//i.test(url);
  $('tabCard').classList.toggle('unsupported', !supported);
  $('tabBadge').textContent = supported ? 'READY' : 'UNSUPPORTED';
  $('tabBadge').className = `badge ${supported ? 'ok' : 'error'}`;
  $('tabName').textContent = state.tab && state.tab.title
    ? state.tab.title.trim()
    : supported ? 'Untitled website' : 'Open a regular website tab';
  $('tabUrl').textContent = supported ? url : 'Chrome settings and internal pages can’t be shared.';
  $('pinHelp').textContent = state.pinned
    ? 'Ready. You’ll approve sharing and control separately.'
    : 'Pin Mars Live to get started.';
  $('manualPin').hidden = state.pinDetectionSupported || state.pinned;

  $('relayValue').textContent = bridgeLabel(state.bridgeUrl);
  $('relayUrl').value = state.bridgeUrl;
  $('relayDot').style.background = parseBridge(state.bridgeUrl) ? 'var(--cyan)' : 'var(--danger)';
  const bridgeValid = !!parseBridge(state.bridgeUrl);
  const ready = state.pinned && supported && bridgeValid && !state.loading && !state.starting;
  $('connectButton').disabled = active || !ready;
  $('connectLabel').textContent = state.starting ? 'Opening…' : 'Connect';
  $('joinButton').disabled = active || !bridgeValid || state.loading;
  $('connectHint').textContent = !state.pinned
    ? 'Pin Mars Live to get started.'
    : !supported
      ? 'Open a regular website tab first.'
      : 'Chrome will ask you to choose a tab.';

  const code = state.existingSession && state.existingSession.code;
  $('sessionPin').textContent = code || '······';
  $('copyPin').disabled = !code;
  $('copyInviteButton').disabled = !code || !bridgeValid;
}

async function refresh() {
  state.loading = true;
  showError('');
  render();
  try {
    const saved = await chrome.storage.local.get(['marsLiveBridgeUrl', 'marsLiveRelayUrl', 'marsLiveSession']);
    if (saved.marsLiveBridgeUrl) {
      state.bridgeUrl = saved.marsLiveBridgeUrl;
    } else if (saved.marsLiveRelayUrl) {
      try {
        const old = new URL(saved.marsLiveRelayUrl);
        old.protocol = old.protocol === 'wss:' ? 'https:' : 'http:';
        old.pathname = '/bridge.php';
        old.hash = '';
        state.bridgeUrl = old.href;
      } catch (error) {}
    }
    state.existingSession = saved.marsLiveSession || null;
    if (state.existingSession && !state.existingSession.bridgeUrl) {
      state.existingSession = null;
      await chrome.storage.local.remove('marsLiveSession');
    }
    if (state.existingSession) {
      try {
        await chrome.windows.get(state.existingSession.windowId);
      } catch (error) {
        state.existingSession = null;
        await chrome.storage.local.remove('marsLiveSession');
      }
    }
    await Promise.all([checkPin(), loadTab()]);
  } catch (error) {
    showError('Chrome could not read the current tab. Reopen Mars Live from the tab you want to share.');
  } finally {
    state.loading = false;
    render();
  }
}

async function ensureBridgePermission(url) {
  const origin = `${url.protocol}//${url.host}/*`;
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (error) {
    throw new Error('Chrome could not approve the PHP bridge. Try Connection settings again.');
  }
}

$('manualPin').addEventListener('click', async () => {
  state.manualPinned = true;
  await checkPin();
  render();
});

$('saveRelay').addEventListener('click', async () => {
  showError('');
  const url = parseBridge($('relayUrl').value.trim());
  if (!url) {
    showError('Paste the HTTP or HTTPS address of bridge.php.');
    $('relayUrl').focus();
    return;
  }
  state.bridgeUrl = url.href;
  try {
    await chrome.storage.local.set({ marsLiveBridgeUrl: state.bridgeUrl });
    render();
  } catch (error) {
    showError('The PHP bridge address could not be saved.');
  }
});

$('relayUrl').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('saveRelay').click();
  }
});

$('connectButton').addEventListener('click', async () => {
  if (state.starting || state.existingSession) return;
  showError('');
  const bridge = parseBridge(state.bridgeUrl);
  if (!bridge || !state.tab || !state.pinned) return;
  state.starting = true;
  render();
  try {
    await ensureBridgePermission(bridge);
    await chrome.storage.local.set({
      marsLiveBridgeUrl: bridge.href,
      marsLivePending: {
        targetTabId: state.tab.id,
        bridgeUrl: bridge.href,
        createdAt: Date.now()
      }
    });
    await chrome.windows.create({
      url: chrome.runtime.getURL('session.html'),
      type: 'popup',
      width: 570,
      height: 700
    });
  } catch (error) {
    await chrome.storage.local.remove('marsLivePending').catch(() => {});
    showError(error.message || 'The live session could not start. Try again.');
  } finally {
    state.starting = false;
    render();
  }
});

$('joinButton').addEventListener('click', async () => {
  if (state.existingSession) return;
  const bridge = parseBridge(state.bridgeUrl);
  if (!bridge) return;
  try {
    await ensureBridgePermission(bridge);
    await chrome.storage.local.set({ marsLiveBridgeUrl: bridge.href });
    await chrome.windows.create({
      url: chrome.runtime.getURL('controller.html'),
      type: 'popup',
      width: 1100,
      height: 760
    });
  } catch (error) {
    showError(error.message || 'The controller window could not open.');
  }
});

$('copyPin').addEventListener('click', () => {
  if (state.existingSession && state.existingSession.code) {
    copyText(state.existingSession.code, $('copyPin'), 'Copied');
  }
});

$('copyInviteButton').addEventListener('click', () => {
  const text = inviteText();
  if (text) copyText(text, $('copyInviteButton'), 'Copied');
});

$('openSessionButton').addEventListener('click', async () => {
  if (!state.existingSession) return;
  await chrome.windows.update(state.existingSession.windowId, { focused: true });
});

$('stopSessionButton').addEventListener('click', async () => {
  if (!state.existingSession || !window.confirm('Stop this live session and disconnect the controller?')) return;
  const windowId = state.existingSession.windowId;
  try {
    await chrome.runtime.sendMessage({ type: 'mars-live-action', action: 'stop' });
  } catch (error) {
    try { await chrome.windows.remove(windowId); } catch (closeError) {}
  }
  state.existingSession = null;
  await chrome.storage.local.remove('marsLiveSession').catch(() => {});
  render();
});

$('reloadButton').addEventListener('click', refresh);
window.addEventListener('load', refresh);
