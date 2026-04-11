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

  function captureElement(el) {
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

    const data = {
      html,
      css,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      tag,
      category,
      fontFamilies: [...fontFamilies],
      url: location.href,
      domain: location.hostname,
      capturedAt: Date.now(),
      devicePixelRatio: window.devicePixelRatio || 1
    };

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
    }
    return false;
  });

})();
