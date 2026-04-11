// background.js — Service Worker
// Handles: side panel toggle, screenshot capture, message routing

// Open side panel when the extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Track which tab the side panel is observing
let activeSidePanelTabId = null;

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeSidePanelTabId = tabId;
  // Notify the side panel that the active tab changed
  chrome.runtime.sendMessage({ type: 'TAB_CHANGED', tabId }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tabId === activeSidePanelTabId) {
    chrome.runtime.sendMessage({ type: 'TAB_UPDATED', tabId, url: tab.url }).catch(() => {});
  }
});

// Central message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    // Content script reports active tab to help side panel track context
    case 'CONTENT_READY': {
      activeSidePanelTabId = sender.tab?.id ?? activeSidePanelTabId;
      sendResponse({ ok: true });
      break;
    }

    // Picker cancelled — forward to side panel only
    // _forwarded flag prevents the background re-handling its own broadcast
    case 'PICKER_CANCELLED': {
      if (!message._forwarded) {
        chrome.runtime.sendMessage({ ...message, _forwarded: true }).catch(() => {});
      }
      break;
    }

    // Element captured — take screenshot NOW while the page tab is still in focus,
    // then forward the enriched message to the side panel once.
    case 'ELEMENT_CAPTURED': {
      // Already forwarded — side panel will handle it, background ignores
      if (message._forwarded) break;

      const tabId = sender.tab?.id;
      if (!tabId) {
        // Came from somewhere without a tab context — forward as-is
        chrome.runtime.sendMessage({ ...message, _forwarded: true }).catch(() => {});
        break;
      }

      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          chrome.runtime.sendMessage({ ...message, _forwarded: true, screenshotDataUrl: null }).catch(() => {});
          return;
        }
        // Wait one repaint cycle so the picker overlay is visually gone before capturing
        setTimeout(() => {
          chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError) {
              console.warn('[atomic-strip] captureVisibleTab failed:', chrome.runtime.lastError.message);
            }
            chrome.runtime.sendMessage({
              ...message,
              _forwarded: true,
              screenshotDataUrl: chrome.runtime.lastError ? null : (dataUrl || null)
            }).catch(() => {});
          });
        }, 120);
      });
      break;
    }
  }
});
