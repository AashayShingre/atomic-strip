// Proves the capture-queue poison bug and the fix.
// Simulates chrome.tabs.captureVisibleTab where ONE call throws mid-sweep,
// then checks whether SUBSEQUENT captures still resolve (good) or hang (bug).

function makeChrome(failOnCall) {
  let n = 0;
  return {
    runtime: { lastError: null },
    tabs: {
      captureVisibleTab(windowId, opts, cb) {
        n++;
        if (n === failOnCall) throw new Error('No window with id: ' + windowId);
        // normal async success
        setTimeout(() => cb('data:image/png;base64,IMG' + n), 5);
      },
    },
  };
}

// ── OLD implementation (poisons the chain) ──
function makeOld(chrome) {
  let captureChain = Promise.resolve();
  let lastCaptureTs = 0;
  return function queuedCapture(windowId) {
    captureChain = captureChain.then(async () => {
      const wait = Math.max(0, 0 - (Date.now() - lastCaptureTs));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      return new Promise((resolve) => {
        chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
          lastCaptureTs = Date.now();
          if (chrome.runtime.lastError) resolve(null); else resolve(dataUrl || null);
        });
      });
    });
    return captureChain;
  };
}

// ── NEW implementation (poison-proof) ──
function makeNew(chrome) {
  let captureChain = Promise.resolve();
  let lastCaptureTs = 0;
  function captureOnce(windowId) {
    return new Promise((resolve) => {
      try {
        const cb = (dataUrl) => {
          lastCaptureTs = Date.now();
          if (chrome.runtime.lastError) resolve(null); else resolve(dataUrl || null);
        };
        if (windowId == null) chrome.tabs.captureVisibleTab({ format: 'png' }, cb);
        else chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, cb);
      } catch (e) { lastCaptureTs = Date.now(); resolve(null); }
    });
  }
  return function queuedCapture(windowId) {
    const next = captureChain.then(async () => {
      const wait = Math.max(0, 0 - (Date.now() - lastCaptureTs));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      return captureOnce(windowId);
    }).catch(() => null);
    captureChain = next.catch(() => null);
    return next;
  };
}

// Run 6 sequential captures; #3 throws. Record each result with a hard timeout
// (a hung/never-resolving promise counts as a failure).
async function runSweep(queuedCapture, label) {
  const results = [];
  for (let i = 1; i <= 6; i++) {
    const r = await Promise.race([
      queuedCapture(7).catch(() => 'REJECTED'),
      new Promise((res) => setTimeout(() => res('HUNG'), 200)),
    ]);
    results.push(r === null ? 'null' : typeof r === 'string' && r.startsWith('data:') ? 'IMG' : r);
  }
  console.log(label, results.join(', '));
  return results;
}

(async () => {
  const oldRes = await runSweep(makeOld(makeChrome(3)), 'OLD:');
  const newRes = await runSweep(makeNew(makeChrome(3)), 'NEW:');

  const oldRecovered = oldRes.slice(3).filter((r) => r === 'IMG').length;
  const newRecovered = newRes.slice(3).filter((r) => r === 'IMG').length;
  console.log('\nAfter the throw on capture #3:');
  console.log('  OLD recovered captures (4-6):', oldRecovered, '/ 3');
  console.log('  NEW recovered captures (4-6):', newRecovered, '/ 3');
  console.log(newRecovered === 3 && oldRecovered < 3 ? '\nPASS: fix recovers; old impl stayed broken.' : '\nresult differs from expectation');
})();
