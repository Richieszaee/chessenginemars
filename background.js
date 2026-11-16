// Relays messages between Chess.com tabs and the offscreen Stockfish engine.
let engine = null;              // port to offscreen document
let ensuring = null;            // in-flight ensureOffscreen promise
const queuedByTab = new Map();  // tabId -> latest request waiting for the engine
const tabs = new Map();         // tabId -> port

async function ensureOffscreen() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    try {
      if (chrome.runtime.getContexts) {
        const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (ctx.length) return;
      }
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run the Stockfish chess engine in a Web Worker'
      });
    } catch (e) { /* already exists */ }
    finally { ensuring = null; }
  })();
  return ensuring;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'engine') {
    engine = port;
    port.onMessage.addListener((m) => {
      const t = tabs.get(m.tabId);
      if (t) { try { t.postMessage(m); } catch (e) {} }
    });
    port.onDisconnect.addListener(() => { if (engine === port) engine = null; });
    for (const m of queuedByTab.values()) {
      try { port.postMessage(m); } catch (e) {}
    }
    queuedByTab.clear();
    return;
  }
  if (port.name === 'tab' && port.sender && port.sender.tab) {
    const id = port.sender.tab.id;
    tabs.set(id, port);
    port.onDisconnect.addListener(() => {
      if (tabs.get(id) === port) tabs.delete(id);
      queuedByTab.delete(id);
      if (engine) { try { engine.postMessage({ type: 'stop', tabId: id }); } catch (e) {} }
    });
    port.onMessage.addListener(async (m) => {
      m.tabId = id;
      if (engine) {
        try { engine.postMessage(m); return; } catch (e) { engine = null; }
      }
      queuedByTab.set(id, m);
      await ensureOffscreen();
    });
  }
});

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (!tab) return;
    const t = tabs.get(tab.id);
    if (t) { try { t.postMessage({ type: 'toggle' }); } catch (e) {} }
  });
}
