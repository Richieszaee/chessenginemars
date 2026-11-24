// Mars Live keeps no background capture or remote-access state.
// A live session exists only while its visible control panel is open.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  try {
    await chrome.storage.local.set({ marsLiveRelayUrl: 'ws://127.0.0.1:8787/ws' });
  } catch (error) {
    // The popup supplies the same safe default if storage is unavailable.
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await chrome.storage.local.remove(['marsLiveSession', 'marsLivePending']);
  } catch (error) {
    // Nothing to clean up.
  }
});
