const $ = (id) => document.getElementById(id);
const state = {
  pinned: false,
  pinDetectionSupported: true,
  manualPinned: false,
  tab: null,
  relayUrl: 'ws://127.0.0.1:8787/ws',
  existingSession: null,
  loading: true,
  starting: false
};

function showError(message) {
  $('errorMessage').textContent = message || '';
  $('errorMessage').hidden = !message;
}

function parseRelay(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
    return url;
  } catch (error) {
    return null;
  }
}

function websiteUrl() {
  const relay = parseRelay((state.existingSession && state.existingSession.relayUrl) || state.relayUrl);
  if (!relay) return '';
  const url = new URL(relay.href);
  url.protocol = relay.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/connect';
  url.hash = '';
  url.search = '';
  const code = state.existingSession && state.existingSession.code;
  if (code) url.searchParams.set('pin', code);
  return url.href;
}

function relayLabel(value) {
  const url = parseRelay(value);
  if (!url) return 'Invalid address';
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  return local ? 'Local' : url.host;
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
  const original = button.textContent;
  button.textContent = label;
  setTimeout(() => { button.textContent = original; }, 1200);
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

  $('relayValue').textContent = relayLabel(state.relayUrl);
  $('relayUrl').value = state.relayUrl;
  $('relayDot').style.background = parseRelay(state.relayUrl) ? 'var(--cyan)' : 'var(--danger)';
  const relayValid = !!parseRelay(state.relayUrl);
  const ready = state.pinned && supported && relayValid && !state.loading && !state.starting;
  $('connectButton').disabled = active || !ready;
  $('connectLabel').textContent = state.starting ? 'Opening…' : 'Connect';
  $('connectHint').textContent = !state.pinned
    ? 'Pin Mars Live to get started.'
    : !supported
      ? 'Open a regular website tab first.'
      : 'Chrome will ask you to choose a tab.';

  const code = state.existingSession && state.existingSession.code;
  $('sessionPin').textContent = code || '······';
  $('copyPin').disabled = !code;
  $('openWebsiteButton').disabled = !code || !websiteUrl();
  $('copyInviteButton').disabled = !code || !websiteUrl();
}

async function refresh() {
  state.loading = true;
  showError('');
  render();
  try {
    const saved = await chrome.storage.local.get(['marsLiveRelayUrl', 'marsLiveSession']);
    if (saved.marsLiveRelayUrl) state.relayUrl = saved.marsLiveRelayUrl;
    state.existingSession = saved.marsLiveSession || null;
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

async function ensureRelayPermission(url) {
  const origin = `${url.protocol}//${url.hostname}/*`;
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (error) {
    throw new Error('Chrome could not approve the relay connection. Try Connection settings again.');
  }
}

$('manualPin').addEventListener('click', async () => {
  state.manualPinned = true;
  await checkPin();
  render();
});

$('saveRelay').addEventListener('click', async () => {
  showError('');
  const url = parseRelay($('relayUrl').value.trim());
  if (!url) {
    showError('Paste an http://, https://, ws://, or wss:// relay address.');
    $('relayUrl').focus();
    return;
  }
  state.relayUrl = url.href;
  try {
    await chrome.storage.local.set({ marsLiveRelayUrl: state.relayUrl });
    render();
  } catch (error) {
    showError('The relay address could not be saved.');
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
  const relay = parseRelay(state.relayUrl);
  if (!relay || !state.tab || !state.pinned) return;
  state.starting = true;
  render();
  try {
    await ensureRelayPermission(relay);
    await chrome.storage.local.set({
      marsLiveRelayUrl: relay.href,
      marsLivePending: {
        targetTabId: state.tab.id,
        relayUrl: relay.href,
        createdAt: Date.now()
      }
    });
    await chrome.windows.create({
      url: chrome.runtime.getURL('session.html'),
      type: 'popup',
      width: 570,
      height: 790
    });
  } catch (error) {
    await chrome.storage.local.remove('marsLivePending').catch(() => {});
    showError(error.message || 'The live session could not start. Try again.');
  } finally {
    state.starting = false;
    render();
  }
});

$('copyPin').addEventListener('click', () => {
  if (state.existingSession && state.existingSession.code) {
    copyText(state.existingSession.code, $('copyPin'), 'Copied');
  }
});

$('openWebsiteButton').addEventListener('click', () => {
  const url = websiteUrl();
  if (url) chrome.tabs.create({ url });
});

$('copyInviteButton').addEventListener('click', () => {
  const url = websiteUrl();
  if (url) copyText(url, $('copyInviteButton'), 'Copied');
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
