// content.js — Injected into every page
// Handles: style extraction, element picker mode

(function () {
  'use strict';

  // Avoid double-injection
  if (window.__atomicStripLoaded) return;
  window.__atomicStripLoaded = true;

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  // ─────────────────────────────────────────────
  // STYLE EXTRACTION
  // ─────────────────────────────────────────────

  function extractCSSVariables() {
    const vars = {};
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          if (rule.type === CSSRule.STYLE_RULE &&
              (rule.selectorText === ':root' || rule.selectorText === 'html')) {
            for (const prop of rule.style) {
              if (prop.startsWith('--')) {
                vars[prop] = rule.style.getPropertyValue(prop).trim();
              }
            }
          }
        }
      }
    } catch {}
    return vars;
  }

  function parseRgb(colorStr) {
    const m = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : null;
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [h * 360, s * 100, l * 100];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  function hslDistance([h1, s1, l1], [h2, s2, l2]) {
    const dh = Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2)) / 180;
    const ds = Math.abs(s1 - s2) / 100;
    const dl = Math.abs(l1 - l2) / 100;
    return Math.sqrt(dh * dh * 2 + ds * ds + dl * dl);
  }

  function clusterColors(entries) {
    const THRESHOLD = 0.18;
    const clusters = [];
    for (const { hex, count } of entries) {
      const rgb = parseRgb(hex) || (() => {
        const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
      })();
      if (!rgb) continue;
      const hsl = rgbToHsl(...rgb);

      let placed = false;
      for (const c of clusters) {
        if (hslDistance(hsl, c.hsl) < THRESHOLD) {
          c.count += count;
          if (count > c.topCount) { c.hex = hex; c.hsl = hsl; c.topCount = count; }
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ hex, hsl, count, topCount: count });
    }
    return clusters.sort((a, b) => b.count - a.count);
  }

  function extractColors() {
    const freq = new Map();

    const walk = (el) => {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'SVG') return;
      const cs = getComputedStyle(el);
      const props = ['color', 'backgroundColor', 'borderTopColor', 'outlineColor', 'caretColor'];
      for (const prop of props) {
        const val = cs[prop];
        if (!val || val === 'rgba(0, 0, 0, 0)' || val === 'transparent') continue;
        const rgb = parseRgb(val);
        if (!rgb) continue;
        const hex = rgbToHex(...rgb);
        freq.set(hex, (freq.get(hex) || 0) + 1);
      }
    };

    // Walk top-level important elements for frequency signal
    document.querySelectorAll('*').forEach(walk);

    const entries = Array.from(freq.entries())
      .map(([hex, count]) => ({ hex, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 200);

    const clustered = clusterColors(entries);
    return {
      smart: clustered.slice(0, 10),   // top clusters for smart view
      full: clustered                   // all clusters
    };
  }

  function extractTypography() {
    const families = new Map();
    const sizes = new Map();
    const weights = new Map();
    const lineHeights = new Map();
    const letterSpacings = new Map();

    const selectors = 'body,h1,h2,h3,h4,h5,h6,p,a,button,input,label,span,li,blockquote,code,pre';
    document.querySelectorAll(selectors).forEach(el => {
      const cs = getComputedStyle(el);
      const ff = cs.fontFamily?.split(',')[0].trim().replace(/['"]/g, '');
      const fs = cs.fontSize;
      const fw = cs.fontWeight;
      const lh = cs.lineHeight;
      const ls = cs.letterSpacing;

      if (ff) families.set(ff, (families.get(ff) || 0) + 1);
      if (fs && fs !== '0px') sizes.set(fs, (sizes.get(fs) || 0) + 1);
      if (fw) weights.set(fw, (weights.get(fw) || 0) + 1);
      if (lh && lh !== 'normal') lineHeights.set(lh, (lineHeights.get(lh) || 0) + 1);
      if (ls && ls !== 'normal' && ls !== '0px') letterSpacings.set(ls, (letterSpacings.get(ls) || 0) + 1);
    });

    const sortedByFreq = (map) =>
      Array.from(map.entries()).sort((a, b) => b[1] - a[1]).map(([v]) => v);

    const pxToNum = (s) => parseFloat(s) || 0;
    const sortedSizes = Array.from(sizes.keys()).sort((a, b) => pxToNum(a) - pxToNum(b));

    return {
      fontFamilies: sortedByFreq(families),
      fontSizes: sortedSizes,
      fontWeights: [...new Set(sortedByFreq(weights))],
      lineHeights: sortedByFreq(lineHeights).slice(0, 6),
      letterSpacings: sortedByFreq(letterSpacings).slice(0, 6)
    };
  }

  function extractSpacing() {
    const vals = new Map();
    document.querySelectorAll('div,section,article,main,header,footer,nav,aside').forEach(el => {
      const cs = getComputedStyle(el);
      const props = ['paddingTop','paddingRight','paddingBottom','paddingLeft',
                     'marginTop','marginRight','marginBottom','marginLeft',
                     'gap','rowGap','columnGap'];
      for (const p of props) {
        const v = cs[p];
        if (v && v !== '0px' && v !== 'auto') {
          vals.set(v, (vals.get(v) || 0) + 1);
        }
      }
    });
    return Array.from(vals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([v]) => v)
      .filter(v => parseFloat(v) > 0)
      .slice(0, 20);
  }

  function extractBorderRadii() {
    const vals = new Map();
    document.querySelectorAll('button,input,img,div,a,span').forEach(el => {
      const v = getComputedStyle(el).borderRadius;
      if (v && v !== '0px') vals.set(v, (vals.get(v) || 0) + 1);
    });
    return Array.from(vals.entries()).sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, 8);
  }

  function extractShadows() {
    const vals = new Map();
    document.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      const v = cs.boxShadow;
      if (v && v !== 'none') vals.set(v, (vals.get(v) || 0) + 1);
    });
    return Array.from(vals.entries()).sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, 6);
  }

  function extractFavicon() {
    const link = document.querySelector('link[rel*="icon"]');
    return link?.href || null;
  }

  function runFullExtraction() {
    return {
      url: location.href,
      domain: location.hostname,
      title: document.title,
      favicon: extractFavicon(),
      capturedAt: Date.now(),
      cssVariables: extractCSSVariables(),
      colors: extractColors(),
      typography: extractTypography(),
      spacing: extractSpacing(),
      borderRadii: extractBorderRadii(),
      shadows: extractShadows()
    };
  }

  // ─────────────────────────────────────────────
  // ELEMENT PICKER
  // ─────────────────────────────────────────────

  let pickerActive = false;
  let pickerOverlay = null;
  let pickerHighlight = null;
  let pickerTooltip = null;
  let hoveredEl = null;

  function buildPickerUI() {
    // Highlight box
    pickerHighlight = document.createElement('div');
    pickerHighlight.id = '__as_highlight__';
    Object.assign(pickerHighlight.style, {
      position: 'fixed',
      pointerEvents: 'none',
      border: '2px solid #7B68EE',
      borderRadius: '3px',
      background: 'rgba(123,104,238,0.08)',
      zIndex: '2147483646',
      transition: 'all 0.1s ease',
      display: 'none'
    });

    // Tooltip
    pickerTooltip = document.createElement('div');
    pickerTooltip.id = '__as_tooltip__';
    Object.assign(pickerTooltip.style, {
      position: 'fixed',
      pointerEvents: 'none',
      background: '#1a1a2e',
      color: '#e0e0ff',
      fontSize: '11px',
      fontFamily: 'monospace',
      padding: '4px 8px',
      borderRadius: '4px',
      zIndex: '2147483647',
      display: 'none',
      border: '1px solid #7B68EE',
      whiteSpace: 'nowrap'
    });

    // Overlay (transparent, captures mouse events)
    pickerOverlay = document.createElement('div');
    pickerOverlay.id = '__as_overlay__';
    Object.assign(pickerOverlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483645',
      cursor: 'crosshair'
    });

    // Top bar instruction
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      background: '#1a1a2e',
      color: '#e0e0ff',
      fontSize: '12px',
      fontFamily: 'system-ui, sans-serif',
      padding: '8px 16px',
      zIndex: '2147483647',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      borderBottom: '1px solid #7B68EE'
    });
    bar.innerHTML = `
      <span>⚡ <strong>Atomic Strip</strong> — Hover to select a component, click to capture</span>
      <span style="opacity:0.6; font-size:11px">Press <kbd style="background:#333;padding:1px 5px;border-radius:3px">Esc</kbd> to cancel · <kbd style="background:#333;padding:1px 5px;border-radius:3px">↑</kbd> to go up the DOM</span>
    `;
    pickerOverlay.appendChild(bar);

    document.body.appendChild(pickerOverlay);
    document.body.appendChild(pickerHighlight);
    document.body.appendChild(pickerTooltip);
  }

  function destroyPickerUI() {
    pickerOverlay?.remove();
    pickerHighlight?.remove();
    pickerTooltip?.remove();
    pickerOverlay = pickerHighlight = pickerTooltip = hoveredEl = null;
  }

  function updateHighlight(el) {
    if (!el || !pickerHighlight) return;
    hoveredEl = el;
    const rect = el.getBoundingClientRect();
    Object.assign(pickerHighlight.style, {
      display: 'block',
      top: rect.top + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px'
    });

    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = [...el.classList].slice(0, 2).map(c => `.${c}`).join('');
    const dims = `${Math.round(rect.width)}×${Math.round(rect.height)}`;

    pickerTooltip.textContent = `${tag}${id}${cls}  ${dims}px`;
    const tooltipTop = Math.max(rect.top - 28, 40);
    Object.assign(pickerTooltip.style, {
      display: 'block',
      top: tooltipTop + 'px',
      left: Math.min(rect.left, window.innerWidth - 240) + 'px'
    });
  }

  function getRelevantCSS(el) {
    const elements = [el, ...el.querySelectorAll('*')];
    const matchedRules = [];
    const seenCss = new Set();
    const referencedKeyframes = new Set();

    // Strip pseudo-classes (:hover, :focus, :active …) and pseudo-elements
    // (::before, ::after, ::placeholder …) so we can match the base element
    // even when it isn't in those states right now.
    function baseSelector(selectorText) {
      return selectorText
        .split(',')
        .map(s => s
          .replace(/::[\w-]+(\([^)]*\))?/g, '')  // pseudo-elements
          .replace(/:[\w-]+(\([^)]*\))?/g, '')    // pseudo-classes
          .trim()
        )
        .filter(s => s.length > 0)
        .join(',');
    }

    function selectorMatchesTree(selectorText) {
      // 1. Exact match (covers normal selectors and currently-active states)
      try {
        if (elements.some(e => e.matches(selectorText))) return true;
      } catch {}
      // 2. Base match — strip pseudo-classes/elements and retry
      //    This captures :hover, :focus, ::before etc. rules
      const base = baseSelector(selectorText);
      if (!base) return false;
      try {
        return elements.some(e => e.matches(base));
      } catch {}
      return false;
    }

    function resolveVars(cssText) {
      return cssText.replace(/var\((--[^,)]+)(?:,[^)]*)?\)/g, (_, varName) => {
        return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || _;
      });
    }

    function addRule(cssText) {
      if (!seenCss.has(cssText)) {
        seenCss.add(cssText);
        matchedRules.push(cssText);
      }
    }

    // Seed keyframe names from currently-running animations
    elements.forEach(e => {
      const anim = getComputedStyle(e).animationName;
      if (anim && anim !== 'none') anim.split(',').forEach(n => referencedKeyframes.add(n.trim()));
    });

    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          if (rule.type !== CSSRule.STYLE_RULE) continue;
          if (!selectorMatchesTree(rule.selectorText)) continue;

          const cssText = resolveVars(rule.cssText);
          addRule(cssText);

          // Also harvest animation names from matched rules so we pick up
          // keyframes that are only triggered on :hover / :focus etc.
          const animMatch = cssText.match(/animation(?:-name)?\s*:\s*([^;]+)/g);
          if (animMatch) {
            animMatch.forEach(m => {
              m.replace(/:\s*([^;,\s]+)/g, (_, name) => {
                if (name !== 'none') referencedKeyframes.add(name.trim());
              });
            });
          }
        }
      }
    } catch {}

    // Collect all referenced @keyframes blocks
    if (referencedKeyframes.size > 0) {
      try {
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch { continue; }
          for (const rule of rules) {
            if (rule.type === CSSRule.KEYFRAMES_RULE && referencedKeyframes.has(rule.name)) {
              addRule(rule.cssText);
            }
          }
        }
      } catch {}
    }

    return matchedRules.join('\n');
  }

  // ─────────────────────────────────────────────
  // INTERACTION PROBE  (primitive agentic flow)
  // After capturing the resting element, "drive" its interactive parts: move a
  // visible cursor over each, fire synthetic hover/focus, and force the matching
  // CSS :hover rules (synthetic events alone can't trigger native :hover). A
  // MutationObserver records DOM that appears (dropdowns, tooltips, injected
  // nodes — incl. those portaled to <body>) and we screenshot each revealed
  // state. All states are sent to the side panel to feed "Generate with AI".
  // ─────────────────────────────────────────────

  const PROBE_MAX = 16;       // cap how many interactive parts we exercise
  const PROBE_SETTLE_MS = 500; // minimum wait for transitions / JS after hover
  const PROBE_RESET_MS = 220;  // wait after un-hover before the next probe
  const PROBE_QUIET_MS = 850;  // consider settled after this long with no DOM changes
                               // (wide enough to bridge a typical fetch gap in an
                               //  async tooltip/hovercard before its content lands)
  const PROBE_MAX_WAIT_MS = 6000; // hard cap waiting for slow async reveals
  const FORCE_STATE_CLASS = '__as_force_state__';
  const STATE_PSEUDO = /:(hover|focus|focus-visible|focus-within|active)\b/g;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait for content to settle after an action: always wait at least PROBE_SETTLE_MS,
  // then keep waiting until `getCount()` (e.g. mutation count) stops changing for
  // PROBE_QUIET_MS — so slow, async-loaded reveals (tooltips, fetched menus) are
  // captured — up to PROBE_MAX_WAIT_MS.
  async function waitForSettle(getCount) {
    const start = Date.now();
    await sleep(PROBE_SETTLE_MS);
    let last = getCount ? getCount() : 0;
    let lastChange = Date.now();
    while (Date.now() - start < PROBE_MAX_WAIT_MS) {
      await sleep(150);
      const c = getCount ? getCount() : 0;
      if (c !== last) { last = c; lastChange = Date.now(); }
      else if (Date.now() - lastChange >= PROBE_QUIET_MS) break;
    }
  }

  function stripPseudo(selectorText) {
    return selectorText
      .split(',')
      .map((s) => s
        .replace(/::[\w-]+(\([^)]*\))?/g, '')
        .replace(/:[\w-]+(\([^)]*\))?/g, '')
        .trim())
      .filter(Boolean)
      .join(',');
  }

  function describeEl(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
    const di = el.getAttribute && el.getAttribute('data-interaction');
    return `${tag}${id}${cls}${di ? `[data-interaction=${di}]` : ''}`;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function ancestorsOf(el) {
    const out = [];
    let p = el.parentElement;
    while (p && p !== document.documentElement) { out.push(p); p = p.parentElement; }
    return out;
  }

  // Temporarily re-apply matching :hover/:focus rules unconditionally so pure-CSS
  // reveals become visible for the screenshot. Returns a cleanup function.
  function applyForcedHover(el) {
    const chain = [el, ...el.querySelectorAll('*'), ...ancestorsOf(el)];
    const forced = [];
    const seen = new Set();
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          if (rule.type !== CSSRule.STYLE_RULE) continue;
          STATE_PSEUDO.lastIndex = 0;
          if (!STATE_PSEUDO.test(rule.selectorText)) continue;
          const base = stripPseudo(rule.selectorText);
          if (!base) continue;
          let relevant = false;
          try { relevant = chain.some((e) => e.matches(base)); } catch {}
          if (!relevant) continue;
          const forcedSelector = rule.selectorText
            .replace(STATE_PSEUDO, '')
            .split(',')
            .map((s) => `.${FORCE_STATE_CLASS} ${s.trim()}`)
            .join(',');
          const text = `${forcedSelector}{${rule.style.cssText}}`;
          if (!seen.has(text)) { seen.add(text); forced.push(text); }
        }
      }
    } catch {}

    if (!forced.length) return () => {};
    const styleEl = document.createElement('style');
    styleEl.dataset.asForce = '1'; // so the probe ignores its own injected style
    styleEl.textContent = forced.join('\n');
    document.head.appendChild(styleEl);
    document.documentElement.classList.add(FORCE_STATE_CLASS);
    return () => {
      styleEl.remove();
      document.documentElement.classList.remove(FORCE_STATE_CLASS);
    };
  }

  function fireMouse(el, type, x, y) {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
  }
  function dispatchHover(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'].forEach((t) => fireMouse(el, t, x, y));
    if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch {} }
  }
  function dispatchUnhover(el) {
    ['mousemove', 'mouseout', 'mouseleave', 'pointerout', 'pointerleave'].forEach((t) => fireMouse(el, t));
    if (typeof el.blur === 'function') { try { el.blur(); } catch {} }
  }

  // Many JS-driven reveals (e.g. GitHub hovercards) are guarded by a native
  // :hover that synthetic events can't fake — but they expose a keyboard trigger
  // via `aria-keyshortcuts` (e.g. "Alt+ArrowUp"). Focus the element and fire that
  // combo so the reveal opens without a real pointer. No-op if not present.
  function dispatchKeyShortcut(el) {
    const ks = el.getAttribute && el.getAttribute('aria-keyshortcuts');
    if (!ks) return;
    const combo = ks.split(/\s+/)[0];           // first declared shortcut
    const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
    const init = {
      bubbles: true, cancelable: true, key,
      altKey: mods.includes('alt'),
      ctrlKey: mods.includes('control') || mods.includes('ctrl'),
      metaKey: mods.includes('meta') || mods.includes('cmd') || mods.includes('command'),
      shiftKey: mods.includes('shift'),
    };
    try { el.focus({ preventScroll: true }); } catch {}
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
    } catch {}
  }

  // Ask the background worker for a throttled screenshot of the visible tab.
  function requestScreenshotOnce() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE' }, (resp) => {
          if (chrome.runtime.lastError) { console.warn('[atomic-strip] capture error:', chrome.runtime.lastError.message); resolve(null); return; }
          resolve(resp?.dataUrl || null);
        });
      } catch (e) { console.warn('[atomic-strip] capture threw:', e?.message); resolve(null); }
    });
  }

  // captureVisibleTab is rate-limited and can return null when called too soon
  // after the previous capture. Retry once after a short wait before giving up.
  async function requestScreenshot() {
    let url = await requestScreenshotOnce();
    if (!url) { await sleep(800); url = await requestScreenshotOnce(); }
    return url;
  }

  // Crop a full-tab screenshot to a viewport-space rect, in page context.
  function cropInPage(dataUrl, rect, dpr) {
    return new Promise((resolve) => {
      if (!dataUrl) { console.warn('[atomic-strip] crop: no screenshot (capture returned null)'); resolve(null); return; }
      const img = new Image();
      img.onload = () => {
        // Clamp the source rect to the actual image bounds — an element scrolled
        // partly off-screen, or rounding, can push coords past the edge and make
        // drawImage produce a blank/failed canvas.
        let sx = Math.max(0, Math.round(rect.left * dpr));
        let sy = Math.max(0, Math.round(rect.top * dpr));
        let sw = Math.round(rect.width * dpr);
        let sh = Math.round(rect.height * dpr);
        sw = Math.max(1, Math.min(sw, img.naturalWidth - sx));
        sh = Math.max(1, Math.min(sh, img.naturalHeight - sy));
        if (!img.naturalWidth || !img.naturalHeight || sx >= img.naturalWidth || sy >= img.naturalHeight) {
          console.warn('[atomic-strip] crop: rect outside image', { sx, sy, iw: img.naturalWidth, ih: img.naturalHeight });
          resolve(null); return;
        }
        const c = document.createElement('canvas');
        c.width = sw; c.height = sh;
        try {
          c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
          resolve(c.toDataURL('image/png'));
        } catch (e) { console.warn('[atomic-strip] crop: drawImage/toDataURL failed', e?.message); resolve(null); }
      };
      img.onerror = () => { console.warn('[atomic-strip] crop: screenshot failed to decode'); resolve(null); };
      img.src = dataUrl;
    });
  }

  function loadImg(src) {
    return new Promise((res) => {
      if (!src) { res(null); return; }
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => res(null);
      i.src = src;
    });
  }

  function unionRects(a, b) {
    if (!a) return b;
    if (!b) return a;
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    const right = Math.max(a.left + a.width, b.left + b.width);
    const bottom = Math.max(a.top + a.height, b.top + b.height);
    return { top, left, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }

  // Fraction of `changed`'s area that lies OUTSIDE `ref` (0 = fully inside ref,
  // 1 = fully outside). Used to tell a real reveal (tooltip/popover that appears
  // somewhere new) from an in-place hover recolor confined to the element itself.
  function fractionOutside(changed, ref) {
    if (!changed) return 0;
    if (!ref) return 1;
    const ix = Math.max(0, Math.min(changed.left + changed.width, ref.left + ref.width) - Math.max(changed.left, ref.left));
    const iy = Math.max(0, Math.min(changed.top + changed.height, ref.top + ref.height) - Math.max(changed.top, ref.top));
    const interArea = ix * iy;
    const changedArea = Math.max(1, changed.width * changed.height);
    return 1 - interArea / changedArea;
  }

  // Compare two full-tab screenshots and return the viewport-space bounding box
  // of the region that changed (or null if negligible). This catches reveals
  // that appear ANYWHERE on screen — portaled hovercards, popovers rendered
  // outside the picked element, even shadow-DOM content the observer can't see.
  async function diffRect(beforeUrl, afterUrl) {
    const [a, b] = await Promise.all([loadImg(beforeUrl), loadImg(afterUrl)]);
    if (!a || !b) return null;
    const W = Math.min(a.naturalWidth, b.naturalWidth);
    const H = Math.min(a.naturalHeight, b.naturalHeight);
    if (!W || !H) return null;

    const sw = Math.min(360, W);
    const sh = Math.max(1, Math.round(H * (sw / W)));
    const ca = document.createElement('canvas'); ca.width = sw; ca.height = sh;
    const cb = document.createElement('canvas'); cb.width = sw; cb.height = sh;
    const xa = ca.getContext('2d', { willReadFrequently: true });
    const xb = cb.getContext('2d', { willReadFrequently: true });
    xa.drawImage(a, 0, 0, sw, sh);
    xb.drawImage(b, 0, 0, sw, sh);
    let da, db;
    try { da = xa.getImageData(0, 0, sw, sh).data; db = xb.getImageData(0, 0, sw, sh).data; }
    catch { return null; }

    let minX = sw, minY = sh, maxX = -1, maxY = -1, count = 0;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        const diff = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        if (diff > 40) {
          count++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (count < sw * sh * 0.0008) return null; // negligible (noise / antialiasing)

    const scaleX = window.innerWidth / sw;
    const scaleY = window.innerHeight / sh;
    const PAD = 10;
    const left = Math.max(0, minX * scaleX - PAD);
    const top = Math.max(0, minY * scaleY - PAD);
    const right = Math.min(window.innerWidth, (maxX + 1) * scaleX + PAD);
    const bottom = Math.min(window.innerHeight, (maxY + 1) * scaleY + PAD);
    return { top, left, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }

  // Bounding box of root + every currently-visible descendant + any added nodes
  // (so absolutely-positioned dropdowns / portaled tooltips aren't clipped),
  // clamped to the viewport and padded.
  function probeUnionRect(root, addedEls) {
    const rects = [root.getBoundingClientRect()];
    root.querySelectorAll('*').forEach((e) => { if (isVisible(e)) rects.push(e.getBoundingClientRect()); });
    // Include each added element AND its visible descendants, so portaled
    // dropdowns/tooltips whose wrapper has no size aren't clipped out.
    addedEls.forEach((e) => {
      if (isVisible(e)) rects.push(e.getBoundingClientRect());
      try { e.querySelectorAll('*').forEach((c) => { if (isVisible(c)) rects.push(c.getBoundingClientRect()); }); } catch {}
    });
    let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
    rects.forEach((r) => {
      top = Math.min(top, r.top); left = Math.min(left, r.left);
      right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
    });
    const PAD = 12;
    top = Math.max(0, top - PAD);
    left = Math.max(0, left - PAD);
    right = Math.min(window.innerWidth, right + PAD);
    bottom = Math.min(window.innerHeight, bottom + PAD);
    return { top, left, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }

  function findCandidates(root) {
    const sel = 'button,a,[role="button"],[aria-haspopup],[aria-expanded],[data-tooltip],[data-hovercard-url],[data-hovercard-type],[title],[tabindex],[data-interaction]';
    let list = [root, ...root.querySelectorAll(sel)];
    root.querySelectorAll('*').forEach((e) => { if (getComputedStyle(e).cursor === 'pointer') list.push(e); });
    list = [...new Set(list)];
    const score = (e) => {
      let s = 0;
      if (e === root) s += 5;
      if (e.hasAttribute && e.hasAttribute('data-interaction')) s += 4;
      try { if (e.matches('[aria-haspopup],[aria-expanded],[data-tooltip],[data-hovercard-url],[data-hovercard-type]')) s += 3; } catch {}
      try { if (e.matches('button,a,[role="button"]')) s += 1; } catch {}
      return -s;
    };
    list.sort((a, b) => score(a) - score(b));
    return list.slice(0, PROBE_MAX);
  }

  // True if the node itself, or any descendant, is visible. Catches portaled
  // reveals where the added wrapper has zero size but its content is shown.
  function anyVisible(n) {
    if (!n || n.nodeType !== 1) return false;
    if (isVisible(n)) return true;
    try { return [...n.querySelectorAll('*')].some(isVisible); } catch { return false; }
  }

  // True for mutations the probe itself causes — the moving cursor overlay and
  // the forced-hover gating class on <html>. These must NOT count as reveals,
  // or every probe registers a phantom DOM change and nothing gets filtered.
  function isSelfMutation(m) {
    if (m.target === probeCursor) return true; // cursor's style.transform updates
    if (m.target === document.documentElement && m.attributeName === 'class') {
      const v = m.target.getAttribute('class') || '';
      if (v.includes(FORCE_STATE_CLASS)) return true; // forced-hover toggle
    }
    return false;
  }

  function isSelfNode(n) {
    return n === probeCursor || (n.nodeType === 1 && n.tagName === 'STYLE' && n.dataset && n.dataset.asForce === '1');
  }

  function summarizeMutations(mutations) {
    const addedNodes = [], addedEls = [], attrChanges = [];
    const seenAttr = new Set();
    for (const m of mutations) {
      if (isSelfMutation(m)) continue;
      if (m.type === 'childList') {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1 && !isSelfNode(n) && anyVisible(n)) {
            addedEls.push(n);
            addedNodes.push({ selector: describeEl(n), html: (n.outerHTML || '').slice(0, 1500) });
          }
        });
      } else if (m.type === 'attributes') {
        const value = m.target.getAttribute(m.attributeName);
        const sig = `${describeEl(m.target)}|${m.attributeName}=${value}`;
        if (!seenAttr.has(sig)) {
          seenAttr.add(sig);
          attrChanges.push({ selector: describeEl(m.target), attr: m.attributeName, value });
        }
      }
    }
    return { addedNodes, addedEls, attrChanges };
  }

  // Visible cursor that animates to each probed element ("watch the agent move").
  let probeCursor = null;
  function showCursor() {
    probeCursor = document.createElement('div');
    Object.assign(probeCursor.style, {
      position: 'fixed', width: '18px', height: '18px', left: '0', top: '0',
      borderRadius: '50%', background: 'rgba(123,104,238,0.85)',
      boxShadow: '0 0 0 4px rgba(123,104,238,0.25)', zIndex: '2147483647',
      pointerEvents: 'none', transition: 'transform 0.25s ease', transform: 'translate(-50%,-50%)',
    });
    document.body.appendChild(probeCursor);
  }
  function moveCursorTo(el) {
    if (!probeCursor) return;
    const r = el.getBoundingClientRect();
    probeCursor.style.transform = `translate(${r.left + r.width / 2}px, ${r.top + r.height / 2}px) translate(-50%,-50%)`;
  }
  function hideCursor() { probeCursor?.remove(); probeCursor = null; }

  const INTERACTIVE_SEL = 'button,a,[role="button"],[aria-haspopup],[aria-expanded],[data-tooltip],[data-hovercard-url],[data-hovercard-type],[title],[tabindex],[data-interaction]';
  const NESTED_PARENTS = 2;     // revealed parents expanded one level deeper
  const NESTED_CHILDREN = 3;    // revealed children probed per expanded parent
  const MAX_STATES = 12;        // hard cap on states captured per component

  // Perform a single action on an element. Returns a cleanup fn that reverses it.
  function performAction(el, action) {
    const undoForce = applyForcedHover(el);
    if (action === 'focus') {
      try { el.focus({ preventScroll: true }); } catch {}
      return () => { try { el.blur(); } catch {} undoForce(); };
    }
    if (action === 'click') {
      // Neutralize navigation/submit so JS handlers still run but the page doesn't leave.
      const prevent = (e) => e.preventDefault();
      document.addEventListener('click', prevent, { capture: true });
      dispatchHover(el);
      try { el.click(); } catch {}
      document.removeEventListener('click', prevent, { capture: true });
      return () => {
        // Toggle back (most click-opened menus close on a second click)
        const p2 = (e) => e.preventDefault();
        document.addEventListener('click', p2, { capture: true });
        try { el.click(); } catch {}
        document.removeEventListener('click', p2, { capture: true });
        dispatchUnhover(el);
        undoForce();
      };
    }
    // default: hover. Also fire any declared keyboard shortcut (aria-keyshortcuts)
    // so reveals guarded by a native :hover (e.g. GitHub hovercards) still open.
    dispatchHover(el);
    dispatchKeyShortcut(el);
    return () => { dispatchUnhover(el); undoForce(); };
  }

  // Hide the visible probe cursor while a screenshot is taken so it never
  // appears in captured states (and so no-op detection stays reliable).
  async function captureHidingCursor() {
    if (probeCursor) probeCursor.style.display = 'none';
    const dataUrl = await requestScreenshot();
    if (probeCursor) probeCursor.style.display = '';
    return dataUrl;
  }

  // Run a single action from the resting state, capturing the result.
  // Returns null for no-ops (nothing changed) so they don't clutter the output.
  async function probeAction(root, el, action, baselineFull) {
    const mutations = [];
    const obs = new MutationObserver((m) => mutations.push(...m));
    obs.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-hidden', 'data-state'],
    });

    moveCursorTo(el);
    await sleep(120); // let the cursor glide
    const undo = performAction(el, action);
    await waitForSettle(() => mutations.length); // wait out slow async reveals
    obs.disconnect();

    const summary = summarizeMutations(mutations);
    const dpr = window.devicePixelRatio || 1;
    const afterFull = await captureHidingCursor();

    // A reveal counts if the DOM changed (real popover/tooltip/menu injected) OR
    // pixels changed in a region that lands OUTSIDE the hovered element — a new
    // tooltip/hovercard/dropdown appearing elsewhere. A pixel change confined to
    // the element's own box is just an in-place hover recolor (reproducible via
    // CSS :hover), so we ignore it to avoid flooding the output with noise.
    const domChanged = summary.addedNodes.length || summary.attrChanges.length;
    const changedRect = await diffRect(baselineFull, afterFull);
    const elRect = el.getBoundingClientRect();
    const refRect = { top: elRect.top - 8, left: elRect.left - 8, width: elRect.width + 16, height: elRect.height + 16 };
    const pixelReveal = !!changedRect && fractionOutside(changedRect, refRect) > 0.35;
    console.debug('[atomic-strip] probe', describeEl(el), action, {
      mutations: mutations.length, addedNodes: summary.addedNodes.length,
      attrChanges: summary.attrChanges.length, changedRect: !!changedRect,
      pixelReveal, baselineFull: !!baselineFull, afterFull: !!afterFull,
    });
    if (!domChanged && !pixelReveal) { undo(); await sleep(PROBE_RESET_MS); return null; }

    // Crop to the union of the DOM box and the changed-pixels box, so an
    // off-element popover is always inside the screenshot.
    const domRect = probeUnionRect(root, [...summary.addedEls, el]);
    const rect = pixelReveal ? unionRects(domRect, changedRect) : domRect;
    const screenshot = await cropInPage(afterFull, rect, dpr);
    if (!screenshot) console.warn('[atomic-strip] reveal detected but screenshot crop failed for', describeEl(el), action);

    undo();
    await sleep(PROBE_RESET_MS);

    return {
      label: `${action} ${describeEl(el)}`,
      trigger: describeEl(el),
      action,
      addedNodes: summary.addedNodes,
      addedEls: summary.addedEls,
      attrChanges: summary.attrChanges,
      screenshot,
    };
  }

  // Capture a nested step: parent is already open; act on a revealed child.
  async function probeChildOpen(root, parentEl, childEl, action, baselineFull) {
    const mutations = [];
    const obs = new MutationObserver((m) => mutations.push(...m));
    obs.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-hidden', 'data-state'],
    });

    moveCursorTo(childEl);
    await sleep(120);
    const undo = performAction(childEl, action);
    await waitForSettle(() => mutations.length); // wait out slow async reveals
    obs.disconnect();

    const summary = summarizeMutations(mutations);
    const dpr = window.devicePixelRatio || 1;
    const afterFull = await captureHidingCursor();

    const domChanged = summary.addedNodes.length || summary.attrChanges.length;
    const changedRect = await diffRect(baselineFull, afterFull);
    const cr = childEl.getBoundingClientRect();
    const refRect = { top: cr.top - 8, left: cr.left - 8, width: cr.width + 16, height: cr.height + 16 };
    const pixelReveal = !!changedRect && fractionOutside(changedRect, refRect) > 0.35;
    if (!domChanged && !pixelReveal) { undo(); await sleep(PROBE_RESET_MS); return null; }

    const domRect = probeUnionRect(root, [...summary.addedEls, parentEl, childEl]);
    const rect = pixelReveal ? unionRects(domRect, changedRect) : domRect;
    const screenshot = await cropInPage(afterFull, rect, dpr);

    undo();
    await sleep(PROBE_RESET_MS);

    return {
      label: `${describeEl(parentEl)} → ${action} ${describeEl(childEl)}`,
      trigger: `${describeEl(parentEl)} → ${describeEl(childEl)}`,
      action,
      addedNodes: summary.addedNodes,
      attrChanges: summary.attrChanges,
      screenshot,
    };
  }

  // Open a parent (hover, no reset) and return a cleanup fn.
  async function openState(parentEl) {
    const mutations = [];
    const obs = new MutationObserver((m) => mutations.push(...m));
    obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    const undoForce = applyForcedHover(parentEl);
    dispatchHover(parentEl);
    await waitForSettle(() => mutations.length);
    obs.disconnect();
    return () => { dispatchUnhover(parentEl); undoForce(); };
  }

  function currentInteractive() {
    const set = new Set();
    document.querySelectorAll(INTERACTIVE_SEL).forEach((e) => { if (isVisible(e)) set.add(e); });
    return set;
  }

  // Heuristic interaction probe — NO AI. Runs at pick time: it exercises EVERY
  // interactive part of the component (hover), records what each reveals, and
  // screenshots it, then explores one level of nested UI for parts that opened
  // something. The captured states are sent to the side panel and are only fed
  // to the LLM later, when the user clicks "Reconstruct with AI".
  async function runInteractionProbe(root, captureId) {
    showCursor();
    const states = [];
    try {
      const candidates = findCandidates(root);
      const baselineVisible = currentInteractive();
      const baselineFull = await captureHidingCursor();
      console.debug('[atomic-strip] sweep start', { root: describeEl(root), candidates: candidates.length, baselineFull: !!baselineFull });

      // Top-level pass: probe every interactive part.
      const expandable = [];
      for (const el of candidates) {
        if (states.length >= MAX_STATES) break;
        try {
          const state = await probeAction(root, el, 'hover', baselineFull);
          // Keep any state where a reveal was detected (probeAction already
          // returned null for true no-ops). A missing screenshot is a capture
          // hiccup — don't throw away the interaction spec along with it.
          if (state) {
            states.push(state);
            if (state.addedNodes && state.addedNodes.length) expandable.push(el);
          }
        } catch (err) {
          console.warn('[atomic-strip] action failed:', err);
        }
      }

      // Nested pass: for parts that revealed new UI, open them and probe the
      // newly-revealed interactive elements (one level deep).
      for (const parentEl of expandable.slice(0, NESTED_PARENTS)) {
        if (states.length >= MAX_STATES) break;
        const undoParent = await openState(parentEl);
        try {
          const baselineFull2 = await captureHidingCursor();
          const revealed = [];
          document.querySelectorAll(INTERACTIVE_SEL).forEach((e) => {
            if (isVisible(e) && !baselineVisible.has(e)) revealed.push(e);
          });
          for (const child of revealed.slice(0, NESTED_CHILDREN)) {
            if (states.length >= MAX_STATES) break;
            try {
              const state = await probeChildOpen(root, parentEl, child, 'hover', baselineFull2);
              if (state) states.push(state);
            } catch (err) {
              console.warn('[atomic-strip] nested action failed:', err);
            }
          }
        } finally {
          undoParent();
          await sleep(PROBE_RESET_MS);
        }
      }
    } finally {
      hideCursor();
      document.documentElement.classList.remove(FORCE_STATE_CLASS);
    }

    // Strip live element refs (addedEls) before returning across contexts
    const clean = states.slice(0, MAX_STATES).map((s) => ({
      label: s.label, trigger: s.trigger, action: s.action,
      addedNodes: s.addedNodes, attrChanges: s.attrChanges, screenshot: s.screenshot,
    }));
    console.debug('[atomic-strip] sweep done', { captured: clean.length, withScreenshot: clean.filter((s) => s.screenshot).length });
    return clean;
  }

  // Targeted re-probe — exercise specific elements/actions the AGENT asked for
  // (verification-driven). `targets` = [{ selector, action }]. Returns states.
  async function probeTargets(rootEl, targets) {
    showCursor();
    const out = [];
    try {
      const baselineFull = await captureHidingCursor();
      for (const t of (targets || [])) {
        if (out.length >= MAX_STATES) break;
        const action = (t.action === 'click' || t.action === 'focus') ? t.action : 'hover';
        const sel = (t.selector || '').trim();
        let el = null;
        if (sel === ':root' || sel === '') {
          el = rootEl;
        } else {
          try { el = rootEl.querySelector(sel); } catch {}
          if (!el) { try { el = document.querySelector(sel); } catch {} }
        }
        if (!el) continue;
        try {
          const state = await probeAction(rootEl, el, action, baselineFull);
          if (state && state.screenshot) {
            out.push({
              label: state.label, trigger: state.trigger, action: state.action,
              addedNodes: state.addedNodes, attrChanges: state.attrChanges, screenshot: state.screenshot,
            });
          }
        } catch (err) {
          console.warn('[atomic-strip] target probe failed:', err);
        }
      }
    } finally {
      hideCursor();
      document.documentElement.classList.remove(FORCE_STATE_CLASS);
    }
    return out;
  }

  // The most recently picked element is kept live so the interaction sweep can
  // run later (at "Reconstruct with AI" time) on the real node without a reload.
  let lastPicked = null;

  // Build a reasonably-unique CSS selector for re-locating an element after the
  // live reference is lost (e.g. content script re-injected). Best-effort.
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) { try { return `#${CSS.escape(el.id)}`; } catch { return `#${el.id}`; } }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) { try { parts.unshift(`#${CSS.escape(node.id)}`); } catch { parts.unshift(`#${node.id}`); } break; }
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // Re-locate a picked element for a deferred sweep: prefer the live reference,
  // then the stored selector, then a hit-test at the captured rect center.
  function locatePicked(captureId, selector, rect) {
    if (lastPicked && lastPicked.id === captureId && lastPicked.el && lastPicked.el.isConnected) {
      return lastPicked.el;
    }
    if (selector) {
      try { const el = document.querySelector(selector); if (el) return el; } catch {}
    }
    if (rect && rect.width) {
      const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (el) return el;
    }
    return null;
  }

  async function captureElement(el) {
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const html = el.outerHTML;
    const css = getRelevantCSS(el);

    // Collect font URLs used in the subtree
    const fontFamilies = new Set();
    [el, ...el.querySelectorAll('*')].forEach(e => {
      const ff = getComputedStyle(e).fontFamily?.split(',')[0]?.trim().replace(/['"]/g, '');
      if (ff) fontFamilies.add(ff);
    });

    // Tag the element type for auto-categorization
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const classes = [...el.classList].join(' ').toLowerCase();
    let category = 'component';
    if (tag === 'nav' || classes.includes('nav') || role === 'navigation') category = 'navigation';
    else if (tag === 'header' || classes.includes('header') || classes.includes('hero')) category = 'header';
    else if (tag === 'footer' || classes.includes('footer')) category = 'footer';
    else if (classes.includes('card')) category = 'card';
    else if (classes.includes('btn') || classes.includes('button') || tag === 'button') category = 'button';
    else if (classes.includes('modal') || classes.includes('dialog')) category = 'modal';
    else if (classes.includes('form') || tag === 'form') category = 'form';

    const captureId = Date.now();
    const data = {
      html,
      css,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      tag,
      category,
      fontFamilies: [...fontFamilies],
      url: location.href,
      domain: location.hostname,
      capturedAt: captureId,
      devicePixelRatio: window.devicePixelRatio || 1,
      selector: cssPath(el)
    };

    // Keep the live node so the interaction sweep can run later on demand.
    lastPicked = { id: captureId, el };

    // Send the resting capture (background attaches the baseline screenshot).
    // The interaction sweep is deferred to "Reconstruct with AI" (REPROBE).
    chrome.runtime.sendMessage({ type: 'ELEMENT_CAPTURED', data });
  }

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    buildPickerUI();

    pickerOverlay.addEventListener('mousemove', (e) => {
      // Hide overlay briefly to hit-test the real element beneath
      pickerOverlay.style.pointerEvents = 'none';
      const real = document.elementFromPoint(e.clientX, e.clientY);
      pickerOverlay.style.pointerEvents = '';
      if (real && real !== pickerOverlay && real !== pickerHighlight && real !== pickerTooltip) {
        updateHighlight(real);
      }
    });

    pickerOverlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = hoveredEl; // save before stopPicker nulls it
      stopPicker();
      if (target) captureElement(target);
    });

    document.addEventListener('keydown', onPickerKey);
  }

  function stopPicker() {
    if (!pickerActive) return;
    pickerActive = false;
    destroyPickerUI();
    document.removeEventListener('keydown', onPickerKey);
  }

  function onPickerKey(e) {
    if (e.key === 'Escape') {
      stopPicker();
      chrome.runtime.sendMessage({ type: 'PICKER_CANCELLED' });
    }
    // Arrow up = go to parent element
    if (e.key === 'ArrowUp' && hoveredEl) {
      e.preventDefault();
      const parent = hoveredEl.parentElement;
      if (parent && parent !== document.body) updateHighlight(parent);
    }
    // Arrow down = go to first child
    if (e.key === 'ArrowDown' && hoveredEl) {
      e.preventDefault();
      const child = hoveredEl.firstElementChild;
      if (child) updateHighlight(child);
    }
  }

  // ─────────────────────────────────────────────
  // MESSAGE LISTENER
  // ─────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case 'EXTRACT_STYLES':
        try {
          sendResponse({ ok: true, data: runFullExtraction() });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;

      case 'START_PICKER':
        startPicker();
        sendResponse({ ok: true });
        break;

      case 'STOP_PICKER':
        stopPicker();
        sendResponse({ ok: true });
        break;

      // Deferred interaction sweep, triggered by "Reconstruct with AI".
      case 'REPROBE': {
        (async () => {
          try {
            const el = locatePicked(message.captureId, message.selector, message.rect);
            if (!el) { sendResponse({ ok: false, reason: 'not-found' }); return; }
            el.scrollIntoView({ block: 'center', inline: 'center' });
            await sleep(120);
            const states = await runInteractionProbe(el, message.captureId);
            sendResponse({ ok: true, states });
          } catch (err) {
            sendResponse({ ok: false, reason: err?.message || 'probe-failed' });
          }
        })();
        return true; // keep the channel open for the async sendResponse
      }

      // Targeted re-probe of specific triggers requested by the agent.
      case 'REPROBE_TARGETS': {
        (async () => {
          try {
            const root = locatePicked(message.captureId, message.selector, message.rect);
            if (!root) { sendResponse({ ok: false, reason: 'not-found' }); return; }
            const states = await probeTargets(root, message.targets);
            sendResponse({ ok: true, states });
          } catch (err) {
            sendResponse({ ok: false, reason: err?.message || 'probe-failed' });
          }
        })();
        return true; // keep the channel open for the async sendResponse
      }
    }
    return false;
  });

})();
