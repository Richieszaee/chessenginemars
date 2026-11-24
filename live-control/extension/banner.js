// Mars Live consent banner — injected only after the user starts a session.
(function () {
  if (window.__marsLiveBanner) return;
  window.__marsLiveBanner = true;

  const host = document.createElement('div');
  host.className = 'mars-live-banner';
  host.id = 'mars-live-banner';
  host.innerHTML = `
    <div class="mars-live-banner__pulse" aria-hidden="true"></div>
    <div class="mars-live-banner__copy">
      <strong>Mars Live <span data-role="status">Sharing this tab</span></strong>
      <small data-role="hint">Your mouse always works. Stop any time.</small>
    </div>
    <div class="mars-live-banner__actions">
      <button type="button" data-action="allow" data-role="allow" hidden>Allow control</button>
      <button type="button" data-action="decline" data-role="decline" hidden>Decline</button>
      <button type="button" data-action="pause" data-role="pause" hidden>Pause</button>
      <button type="button" data-action="stop" class="mars-live-banner__stop">Stop</button>
    </div>
  `;
  document.documentElement.appendChild(host);

  const byRole = (role) => host.querySelector(`[data-role="${role}"]`);
  function send(action) {
    try { chrome.runtime.sendMessage({ type: 'mars-live-action', action }); } catch (error) {}
  }
  host.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) send(button.dataset.action);
  });

  function render(state) {
    const status = byRole('status');
    const hint = byRole('hint');
    host.classList.toggle('mars-live-banner--granted', !!state.controlGranted && !state.paused);
    host.classList.toggle('mars-live-banner--paused', !!state.paused);
    host.classList.toggle('mars-live-banner--request', !!state.requestPending);
    byRole('allow').hidden = !state.requestPending;
    byRole('decline').hidden = !state.requestPending;
    byRole('pause').hidden = !state.controlGranted;
    byRole('pause').textContent = state.paused ? 'Resume' : 'Pause';
    if (state.requestPending) {
      status.textContent = 'Control requested';
      hint.textContent = 'A controller wants mouse and keyboard access.';
    } else if (state.controlGranted && state.paused) {
      status.textContent = 'Control paused';
      hint.textContent = 'The controller can view, but cannot type or click.';
    } else if (state.controlGranted) {
      status.textContent = 'Remote control live';
      hint.textContent = 'Your mouse always works. Pause or stop any time.';
    } else if (state.controllerConnected) {
      status.textContent = 'Controller viewing';
      hint.textContent = 'View-only. Mouse and keyboard stay locked.';
    } else {
      status.textContent = 'Sharing this tab';
      hint.textContent = 'Your mouse always works. Stop any time.';
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== chrome.runtime.id || !message) return false;
    if (message.type === 'mars-live-state') {
      render(message.state || {});
      sendResponse({ ok: true });
    } else if (message.type === 'mars-live-ended') {
      host.remove();
      window.__marsLiveBanner = false;
      sendResponse({ ok: true });
    }
    return false;
  });

  render({ sharing: true });
})();
