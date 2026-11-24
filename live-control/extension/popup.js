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

function relayLabel(value) {
  const url = parseRelay(value);
  if (!url) return 'Invalid URL';
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  return `${local ? 'Local' : url.protocol.replace(':', '')} · ${url.host}`;
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

function render() {
  const pinStep = $('pinStep');
  const tabStep = $('tabStep');
  pinStep.classList.toggle('done', state.pinned);
  $('pinCheck').textContent = state.pinned ? '✓' : '';
  $('pinBadge').textContent = state.pinned ? 'PINNED' : 'REQUIRED';
  $('pinBadge').className = `badge ${state.pinned ? 'ok' : ''}`;
  $('pinHelp').textContent = state.pinned
    ? 'Pinned and ready. You can open Mars Live from any web tab.'
    : 'Click Chrome’s puzzle icon, then the pin beside Mars Live.';
  $('manualPin').hidden = state.pinDetectionSupported || state.pinned;
  $('manualPin').onclick = () => {
    state.manualPinned = true;
    checkPin().then(render);
  };

  const url = state.tab && state.tab.url ? state.tab.url : '';
  const supported = /^https?:\/\//i.test(url) && !/^https:\/\/chromewebstore\.google\.com\//i.test(url);
  tabStep.classList.toggle('done', supported);
  tabStep.classList.toggle('unsupported', !supported);
  $('tabCheck').textContent = supported ? '✓' : '';
  $('tabBadge').textContent = supported ? 'WEB TAB' : 'UNSUPPORTED';
  $('tabBadge').className = `badge ${supported ? 'ok' : 'error'}`;
  let title = state.tab && state.tab.title ? state.tab.title.trim() : '';
  if (!title) title = supported ? 'Untitled web tab' : 'Open a regular http(s) tab to share';
  $('tabName').textContent = title;
  $('tabUrl').textContent = supported ? url : 'Chrome settings, the Web Store, and internal pages cannot be shared.';
  $('relayValue').textContent = relayLabel(state.relayUrl);
  $('relayUrl').value = state.relayUrl;
  $('relayDot').style.background = parseRelay(state.relayUrl) ? 'var(--cyan)' : 'var(--danger)';

  const relayValid = !!parseRelay(state.relayUrl);
  const ready = state.pinned && supported && relayValid && !state.loading;
  $('startButton').disabled = !ready || state.starting;
  if (!state.pinned) $('startLabel').textContent = 'Pin the extension to continue';
  else if (!supported) $('startLabel').textContent = 'Open this on a web tab';
  else if (!relayValid) $('startLabel').textContent = 'Set a valid relay URL';
  else if (state.existingSession) $('startLabel').textContent = 'Open live control panel';
  else $('startLabel').textContent = 'Start a live session';
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
    throw new Error('Chrome could not approve the relay connection. Try the relay settings again.');
  }
}

$('saveRelay').addEventListener('click', async () => {
  showError('');
  const value = $('relayUrl').value.trim();
  const url = parseRelay(value);
  if (!url) {
    showError('Use an https:// or wss:// relay URL without a username or password.');
    $('relayUrl').focus();
    return;
  }
  state.relayUrl = url.href;
  try {
    await chrome.storage.local.set({ marsLiveRelayUrl: state.relayUrl });
    render();
  } catch (error) {
    showError('The relay URL could not be saved locally.');
  }
});

$('relayUrl').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('saveRelay').click();
  }
});

$('startButton').addEventListener('click', async () => {
  if (state.starting) return;
  showError('');
  const relay = parseRelay(state.relayUrl);
  if (!relay || !state.tab || !state.pinned) return;
  state.starting = true;
  render();
  try {
    if (state.existingSession) {
      await chrome.windows.update(state.existingSession.windowId, { focused: true });
      return;
    }
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

$('reloadButton').addEventListener('click', refresh);
window.addEventListener('load', refresh);
