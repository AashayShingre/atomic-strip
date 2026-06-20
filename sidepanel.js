// sidepanel.js — Main UI logic
// Handles: tab switching, style rendering, component management,
//          moodboard, storage (chrome.storage.local + IndexedDB), Claude API

'use strict';

// ─────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────

const DB_NAME = 'atomic-strip';
const DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('components')) {
        d.createObjectStore('components', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('screenshots')) {
        d.createObjectStore('screenshots', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function saveSiteData(domain, data) {
  const saved = await chrome.storage.local.get('sites') || {};
  const sites = saved.sites || {};
  sites[domain] = { ...(sites[domain] || {}), ...data, updatedAt: Date.now() };
  await chrome.storage.local.set({ sites });
  return sites[domain];
}

async function getSiteData(domain) {
  const { sites = {} } = await chrome.storage.local.get('sites');
  return sites[domain] || null;
}

async function getAllSites() {
  const { sites = {} } = await chrome.storage.local.get('sites');
  return sites;
}

async function deleteSite(domain) {
  const { sites = {} } = await chrome.storage.local.get('sites');
  delete sites[domain];
  await chrome.storage.local.set({ sites });
}

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────

async function getClaudeApiKey() {
  const { claudeApiKey = '', apiKey = '' } = await chrome.storage.local.get(['claudeApiKey', 'apiKey']);
  return claudeApiKey || apiKey;
}

async function getGeminiApiKey() {
  const { geminiApiKey = '' } = await chrome.storage.local.get('geminiApiKey');
  return geminiApiKey;
}

async function getAiProvider() {
  const { aiProvider = 'claude' } = await chrome.storage.local.get('aiProvider');
  return aiProvider;
}

async function saveSettings(claudeKey, geminiKey, provider) {
  await chrome.storage.local.set({
    claudeApiKey: claudeKey,
    apiKey: claudeKey,
    geminiApiKey: geminiKey,
    aiProvider: provider
  });
}

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function toast(msg, duration = 2000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Copy text to clipboard
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied!'); }
  catch { toast('Copy failed'); }
}

// Crop a full-tab screenshot to an element's rect
function cropScreenshot(dataUrl, rect, devicePixelRatio = 1) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const dpr = devicePixelRatio;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img,
        rect.left * dpr, rect.top * dpr, rect.width * dpr, rect.height * dpr,
        0, 0, rect.width * dpr, rect.height * dpr
      );
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ─────────────────────────────────────────────
// CLAUDE API
// ─────────────────────────────────────────────

async function callClaude(systemPrompt, userContent, apiKey) {
  const body = {
    model: 'claude-3-5-haiku-latest',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }]
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }

  const result = await resp.json();
  return result.content[0]?.text || '';
}

async function getSupportedGeminiModel(apiKey) {
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (resp.ok) {
      const data = await resp.json();
      const models = data.models || [];
      const geminiModels = models.filter(m =>
        m.name.includes('gemini') &&
        m.supportedGenerationMethods?.includes('generateContent')
      );

      const preferred = [
        'gemini-3.1-flash-lite',
        'gemini-2.5-flash-lite',
        'gemini-3.5-flash',
        'gemini-3-flash',
        'gemini-2.5-flash',
        'gemini-1.5-flash'
      ];
      for (const pref of preferred) {
        const found = geminiModels.find(m => m.name.endsWith(pref));
        if (found) return found.name.split('/').pop();
      }
      if (geminiModels.length > 0) {
        return geminiModels[0].name.split('/').pop();
      }
    }
  } catch (e) {
    console.warn('Failed to list Gemini models:', e);
  }
  return 'gemini-1.5-flash';
}

async function callGemini(systemPrompt, userContent, apiKey) {
  let parts = [];
  if (typeof userContent === 'string') {
    parts.push({ text: userContent });
  } else if (Array.isArray(userContent)) {
    parts = userContent.map(item => {
      if (item.type === 'text') {
        return { text: item.text };
      } else if (item.type === 'image') {
        return {
          inlineData: {
            mimeType: item.source.media_type,
            data: item.source.data
          }
        };
      }
      return null;
    }).filter(Boolean);
  }

  const body = {
    contents: [{ parts }],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    }
  };

  const model = await getSupportedGeminiModel(apiKey);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini API error ${resp.status}`);
  }

  const result = await resp.json();
  return result.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callLLM(systemPrompt, userContent, apiKey, provider) {
  if (provider === 'gemini') {
    return callGemini(systemPrompt, userContent, apiKey);
  } else {
    return callClaude(systemPrompt, userContent, apiKey);
  }
}

// ─────────────────────────────────────────────
// INTERACTION PLANNER (LLM "decide" step for the hybrid agentic probe)
// content.js asks (PROBE_PLAN) which elements to interact with; we let the LLM
// choose, returning a compact action list. content.js executes deterministically.
// ─────────────────────────────────────────────

function parsePlanArray(raw) {
  if (!raw) return [];
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let arr;
  try { arr = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const allowed = new Set(['hover', 'focus', 'click']);
  return arr
    .filter((a) => a && Number.isInteger(a.index))
    .map((a) => ({ index: a.index, action: allowed.has(a.action) ? a.action : 'hover', reason: a.reason || '' }))
    .slice(0, 5);
}

async function planInitialInteractions(message, apiKey, provider) {
  const candList = (message.candidates || [])
    .map((c) => `${c.index}: <${c.tag}> "${c.text}" ${(c.attrs || []).join(' ')} [${c.selector}]`)
    .join('\n');

  const content = [];
  if (message.screenshot) {
    const b64 = message.screenshot.split(',')[1];
    if (b64) {
      content.push({ type: 'text', text: 'Resting-state screenshot of the component:' });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
    }
  }
  content.push({
    type: 'text',
    text: `HTML:\n\`\`\`html\n${message.html || ''}\n\`\`\`\n\nCSS:\n\`\`\`css\n${message.css || ''}\n\`\`\`\n\nCandidate interactive elements (index: <tag> "text" attrs [selector]):\n${candList}\n\nReturn ONLY the JSON array.`,
  });

  const systemPrompt = `You are a UI interaction planner for a design-capture tool.
You are given a captured UI component's HTML, CSS, a resting-state screenshot, and a numbered list of candidate interactive elements.
Decide which candidates are worth interacting with to reveal hidden or dynamic UI (dropdown menus, tooltips, popovers, submenus, toggled content, injected badges).
- SKIP elements unlikely to reveal anything new (plain navigation links, decorative icons, static text).
- For each chosen candidate pick the single action most likely to reveal new UI: "hover", "focus", or "click". Use "click" ONLY for elements that clearly toggle/open content (menus, disclosure buttons) — never for links that navigate to another page.
Return ONLY a JSON array, max 5 items, ordered by importance:
[{"index": <number>, "action": "hover"|"focus"|"click", "reason": "<short>"}]
If nothing is worth probing, return [].`;

  const raw = await callLLM(systemPrompt, content, apiKey, provider);
  return parsePlanArray(raw);
}

async function planReplanInteractions(message, apiKey, provider) {
  const candList = (message.candidates || [])
    .map((c) => `${c.index}: <${c.tag}> "${c.text}" ${(c.attrs || []).join(' ')} [${c.selector}]`)
    .join('\n');
  const history = (message.history || [])
    .map((h) => `- ${h.trigger}${h.added && h.added.length ? ` revealed: ${h.added.join(', ')}` : ''}`)
    .join('\n');

  const systemPrompt = `You are a UI interaction planner exploring nested UI.
The element \`${message.parent || 'a trigger'}\` was activated and revealed new interactive elements (listed below).
Choose up to 2 follow-up actions to reveal DEEPER nested UI (e.g. a submenu/flyout inside the opened menu, a tooltip on a revealed item).
Only pick elements likely to reveal something further; otherwise return [].
Return ONLY a JSON array referring to the NEW candidate list:
[{"index": <number>, "action": "hover"|"focus"|"click", "reason": "<short>"}]`;

  const userText = `Actions already performed:\n${history || '(none)'}\n\nNewly revealed interactive elements (index: <tag> "text" attrs [selector]):\n${candList}\n\nReturn ONLY the JSON array.`;
  const raw = await callLLM(systemPrompt, userText, apiKey, provider);
  return parsePlanArray(raw).slice(0, 2);
}

async function computeProbePlan(message) {
  const provider = await getAiProvider();
  const apiKey = provider === 'gemini' ? await getGeminiApiKey() : await getClaudeApiKey();
  if (!apiKey) return null; // no key → content.js falls back to the heuristic sweep
  if (message.phase === 'replan') return planReplanInteractions(message, apiKey, provider);
  return planInitialInteractions(message, apiKey, provider);
}

function buildInteractionSpec(interactions) {
  if (!interactions || !interactions.length) return '';
  let spec = `\n\n**Observed interaction states (captured automatically by hovering the component's interactive parts — treat these as GROUND TRUTH and reproduce them faithfully):**\n`;
  interactions.forEach((s, i) => {
    spec += `\nState ${i + 1} — triggered by hovering/focusing \`${s.trigger || 'element'}\`:\n`;
    const attrs = s.attrChanges || [];
    const added = s.addedNodes || [];
    if (attrs.length) {
      spec += attrs.map(a => `  - attribute \`${a.attr}\` on \`${a.selector}\` became \`${a.value}\``).join('\n') + '\n';
    }
    if (added.length) {
      spec += added.map(n => `  - a new element \`${n.selector}\` appeared:\n\`\`\`html\n${n.html}\n\`\`\``).join('\n') + '\n';
    }
    if (!attrs.length && !added.length) {
      spec += `  - a visual change occurred (no DOM mutation) — see the accompanying screenshot for this state\n`;
    }
  });
  return spec;
}

async function reconstructComponent(component, screenshotDataUrl, apiKey, provider, interactions = []) {
  const interactionSpec = buildInteractionSpec(interactions);

  const content = [
    {
      type: 'text',
      text: `Reconstruct this UI component captured from ${component.domain}.

**Component Category:** ${component.category}
**Tag Name:** ${component.tag}
**Fonts:** ${component.fontFamilies?.join(', ') || 'unknown'}

**Original HTML:**
\`\`\`html
${component.html}
\`\`\`

**Original CSS (Computed and Rules):**
\`\`\`css
${component.css}
\`\`\`
${interactionSpec}

Provide a single self-contained HTML file. Ensure:
- The design matches the HTML/CSS and the screenshots (resting state + any interaction states) exactly.
- Every observed interaction state above is fully reproduced: the elements that appear on hover/focus (dropdowns, tooltips, popovers, injected badges) must be implemented and shown on the same trigger, even if their markup was NOT present in the original HTML (it may have been rendered dynamically).
- Common interactive behaviors are fully functional, visually refined, and keyboard-accessible.
- Output ONLY the raw HTML code. Do NOT wrap the response in markdown code blocks (\`\`\`), and provide no extra explanation.`
    }
  ];

  // Attach interaction-state screenshots (revealed states) first, labeled
  (interactions || []).forEach((s, i) => {
    if (!s.screenshot) return;
    const base64 = s.screenshot.split(',')[1];
    if (!base64) return;
    content.push({ type: 'text', text: `Interaction state ${i + 1} — after hovering \`${s.trigger || 'element'}\`:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
  });

  // Attach the resting-state screenshot if available
  if (screenshotDataUrl) {
    const base64 = screenshotDataUrl.split(',')[1];
    content.unshift({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: base64 }
    });
    content.unshift({ type: 'text', text: 'Here is a screenshot of the component in its resting state:' });
  }

  const systemPrompt = `You are a world-class senior frontend engineer and UI designer specializing in component reconstruction.
Your goal is to produce a single, production-grade, self-contained HTML file that replicates the visual design and interactive behaviors of the captured UI component with extreme fidelity.

Follow these strict design and coding principles:
1. VISUAL FIDELITY & POLISH: Replicate colors, spacing, alignment, typography, border-radii, borders, and shadows exactly. Ensure it looks premium, clean, and modern.
2. INTERACTIVE STATES: Implement all interactive states:
   - Hover effects (scale, opacity, color shifts, transitions).
   - Focus rings for accessibility.
   - Active/click press feedback.
3. OBSERVED INTERACTION STATES (HIGHEST PRIORITY): If the prompt includes "Observed interaction states", these were captured live by hovering the component and are GROUND TRUTH. Reproduce each one exactly — implement the dropdown/tooltip/popover/badge that appears, wired to the same trigger, with matching content and styling from the accompanying state screenshots. The revealed markup may have been absent from the original HTML (rendered dynamically); recreate it regardless.
4. COMMON INTERACTION INFERENCE (when not directly observed above):
   - Tooltips: Look for attributes like 'title', 'data-tooltip', 'aria-label', 'aria-describedby', or placeholder classes. Construct a clean, animated tooltip positioned correctly relative to the target, visible on hover/focus.
   - Dropdowns & Popovers: If you see indicators like chevrons (▾), 'aria-haspopup', 'aria-expanded', or menu items, implement a fully interactive dropdown toggle with smooth opening/closing transitions.
   - Accordions & Tabs: Implement tab switching or accordion collapse/expand with smooth height transitions and ARIA attributes.
   - Modals & Dialogs: Implement open/close buttons, overlay backdrops, and disable background scroll when open.
4. VANILLA JAVASCRIPT: Write clean, modern, self-contained vanilla ES6+ JavaScript within a <script> tag. Ensure all interaction handlers are robust, prevent default actions where necessary, and support keyboard navigation (e.g., Close on 'Escape').
5. COMPACT CSS: Include a clean <style> block inside the <head>. Resolve duplicate rules, tidy up selectors, and use modern transitions for animations.
6. ASSETS & FONTS: Use relative placeholder URLs for missing images. If external fonts are mentioned, import them using Google Fonts @import.
7. Always output only valid HTML — no explanation text, no markdown code fences.`;

  return callLLM(systemPrompt, content, apiKey, provider);
}

async function generateTags(stylesData, apiKey, provider) {
  const { colors, typography, domain } = stylesData;

  const colorHexes = (colors?.smart || []).map(c => c.hex).join(', ');
  const fonts = (typography?.fontFamilies || []).slice(0, 3).join(', ');

  const prompt = `Analyze this website's design system and return structured tags.

**Domain:** ${domain}
**Primary colors:** ${colorHexes}
**Font families:** ${fonts}
**Font sizes range:** ${(typography?.fontSizes || []).slice(0, 3).join(' → ')} ... ${(typography?.fontSizes || []).slice(-2).join(' → ')}
**Border radii:** ${(stylesData.borderRadii || []).slice(0, 4).join(', ')}

Return ONLY a JSON object with these exact keys (no explanation, no markdown):
{
  "aesthetic": ["tag1", "tag2"],       // design movement: minimal, brutalist, glassmorphism, bento-grid, etc
  "mood": ["tag1", "tag2"],            // emotional tone: playful, corporate, editorial, luxurious, etc
  "colorChar": ["tag1", "tag2"],       // dark-mode, monochromatic, vibrant, pastel, high-contrast, muted, etc
  "typeChar": ["tag1"],                // serif-heavy, mono, display-type, geometric-sans, etc
  "industry": ["tag1"]                 // saas, portfolio, agency, e-commerce, news, fintech, etc
}

Each array should have 1-3 tags maximum. Only include tags you're confident about.`;

  const raw = await callLLM('You are a design analyst. Respond only with valid JSON.', prompt, apiKey, provider);
  // Extract JSON from response
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────

let currentTabId = null;
let currentDomain = null;
let currentExtractedData = null;
let activeComponentId = null; // for modal
let pendingComponent = null;  // picked but not yet saved
let pendingScreenshot = null; // cropped dataUrl for pending component
let pendingInteractions = []; // captured hover/interaction states for pending component

// ─────────────────────────────────────────────
// TAB NAVIGATION
// ─────────────────────────────────────────────

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
  if (tabName === 'moodboard') renderMoodboard(document.getElementById('mb-search')?.value || '');
  if (tabName === 'components') renderComponents();
}

// ─────────────────────────────────────────────
// STYLE RENDERING
// ─────────────────────────────────────────────

function renderColorPalette(containerId, colors) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  colors.forEach(c => {
    const chip = document.createElement('div');
    chip.className = 'color-chip';
    chip.title = `Click to copy ${c.hex}`;
    chip.innerHTML = `
      <div class="color-swatch" style="background:${c.hex}"></div>
      <span class="color-hex">${c.hex}</span>
    `;
    chip.addEventListener('click', () => copyText(c.hex));
    el.appendChild(chip);
  });
}

// ─────────────────────────────────────────────
// SHARED RENDERERS (used by both Styles tab + Moodboard)
// ─────────────────────────────────────────────

// Group CSS variables by their name prefix (e.g. --_aqua-810 → "aqua")
function groupTokens(vars) {
  const groups = {};
  for (const [k, v] of Object.entries(vars)) {
    const clean = k.replace(/^--_*/, '');
    const group = clean.split('-')[0] || 'other';
    if (!groups[group]) groups[group] = [];
    groups[group].push({ k, v });
  }
  return groups;
}

// Returns a DOM element with grouped, collapsible token rows
function buildTokenGroupsEl(vars) {
  const groups = groupTokens(vars);
  const container = document.createElement('div');
  container.className = 'token-groups';

  Object.entries(groups)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([groupName, tokens]) => {
      const group = document.createElement('div');
      group.className = 'token-group';

      const header = document.createElement('div');
      header.className = 'token-group-header';
      header.innerHTML = `
        <span class="token-group-name">${groupName}</span>
        <span class="token-group-count">${tokens.length}</span>
        <span class="token-group-chevron">▾</span>
      `;

      const body = document.createElement('div');
      body.className = 'token-group-body';
      // Collapse by default; expand the first group
      body.style.display = 'none';

      tokens.forEach(({ k, v }) => {
        const isColor = /^(#|rgb|hsl)/.test(v.trim()) || /color/i.test(k);
        const row = document.createElement('div');
        row.className = 'token-row';
        row.style.cursor = 'pointer';
        row.innerHTML = `
          ${isColor ? `<div class="token-swatch" style="background:${v}"></div>` : ''}
          <span class="token-name">${k}</span>
          <span class="token-value">${v}</span>
        `;
        row.addEventListener('click', () => copyText(`${k}: ${v}`));
        body.appendChild(row);
      });

      header.addEventListener('click', () => {
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        header.querySelector('.token-group-chevron').style.transform = isOpen ? '' : 'rotate(180deg)';
      });

      group.appendChild(header);
      group.appendChild(body);
      container.appendChild(group);
    });

  // Auto-expand first group
  const firstBody = container.querySelector('.token-group-body');
  const firstChevron = container.querySelector('.token-group-chevron');
  if (firstBody) {
    firstBody.style.display = 'block';
    firstChevron.style.transform = 'rotate(180deg)';
  }

  return container;
}

// Returns a DOM element matching the Styles tab typography layout
function buildTypographyEl(typo) {
  const wrap = document.createElement('div');

  (typo.fontFamilies || []).slice(0, 4).forEach(ff => {
    const div = document.createElement('div');
    div.className = 'typo-family';
    div.innerHTML = `
      <div class="typo-family-name">${ff}</div>
      <div class="typo-specimen" style="font-family:${ff}">The quick brown fox</div>
      <div class="typo-meta">
        ${[...new Set(typo.fontWeights || [])].map(w => `<span class="chip">${w}</span>`).join('')}
      </div>
    `;
    wrap.appendChild(div);
  });

  if (typo.fontSizes?.length) {
    const sizeRow = document.createElement('div');
    sizeRow.style.marginTop = '10px';
    sizeRow.innerHTML = `<div class="section-title" style="margin-bottom:6px">Size scale</div>`;
    const chips = document.createElement('div');
    chips.className = 'chip-row';
    [...new Set(typo.fontSizes)].forEach(s => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = s;
      chip.addEventListener('click', () => copyText(s));
      chips.appendChild(chip);
    });
    sizeRow.appendChild(chips);
    wrap.appendChild(sizeRow);
  }

  if (typo.lineHeights?.length) {
    const lhRow = document.createElement('div');
    lhRow.style.marginTop = '8px';
    lhRow.innerHTML = `<div class="section-title" style="margin-bottom:6px">Line heights</div>`;
    const chips = document.createElement('div');
    chips.className = 'chip-row';
    typo.lineHeights.forEach(v => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = v;
      chip.addEventListener('click', () => copyText(v));
      chips.appendChild(chip);
    });
    lhRow.appendChild(chips);
    wrap.appendChild(lhRow);
  }

  return wrap;
}

function renderStyles(data) {
  currentExtractedData = data;
  document.getElementById('styles-empty').style.display = 'none';
  const content = document.getElementById('styles-content');
  content.style.display = 'block';

  // CSS Variables / Design Tokens
  const vars = data.cssVariables || {};
  const sectionTokens = document.getElementById('section-tokens');
  if (Object.keys(vars).length > 0) {
    sectionTokens.style.display = 'block';
    document.getElementById('tokens-count').textContent = Object.keys(vars).length;
    const list = document.getElementById('token-list');
    list.innerHTML = '';
    list.appendChild(buildTokenGroupsEl(vars));
  }

  // Colors
  const colors = data.colors || {};
  renderColorPalette('color-palette-smart', colors.smart || []);
  renderColorPalette('color-palette-full', colors.full || []);

  // Toggle smart/full
  const toggleBtn = document.getElementById('colors-toggle');
  let showingFull = false;
  toggleBtn.onclick = () => {
    showingFull = !showingFull;
    document.getElementById('color-palette-smart').style.display = showingFull ? 'none' : 'flex';
    document.getElementById('color-palette-full').style.display = showingFull ? 'flex' : 'none';
    toggleBtn.textContent = showingFull ? 'Show smart' : 'Show all';
  };

  // Typography
  const typo = data.typography || {};
  const typoEl = document.getElementById('typo-content');
  typoEl.innerHTML = '';
  typoEl.appendChild(buildTypographyEl(typo));

  // Spacing
  const spacingEl = document.getElementById('spacing-chips');
  spacingEl.innerHTML = '';
  (data.spacing || []).slice(0, 12).forEach(v => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = v;
    chip.addEventListener('click', () => copyText(v));
    spacingEl.appendChild(chip);
  });

  // Border radius
  const radiusEl = document.getElementById('radius-chips');
  radiusEl.innerHTML = '';
  (data.borderRadii || []).forEach(v => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = v;
    chip.addEventListener('click', () => copyText(v));
    radiusEl.appendChild(chip);
  });

  // Shadows
  const shadows = data.shadows || [];
  const shadowSection = document.getElementById('section-shadows');
  if (shadows.length > 0) {
    shadowSection.style.display = 'block';
    const list = document.getElementById('shadow-list');
    list.innerHTML = '';
    shadows.forEach(s => {
      const item = document.createElement('div');
      item.className = 'shadow-item';
      item.innerHTML = `
        <div class="shadow-demo" style="box-shadow:${s}"></div>
        <div class="shadow-value">${s}</div>
      `;
      item.addEventListener('click', () => copyText(s));
      item.style.cursor = 'pointer';
      list.appendChild(item);
    });
  }
}

// ─────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────

function showComponentPreview(comp, screenshotDataUrl) {
  pendingComponent = comp;
  pendingScreenshot = screenshotDataUrl || null;
  pendingInteractions = [];

  const panel = document.getElementById('component-preview-panel');
  panel.style.display = 'block';

  // Meta line: tag + dimensions
  const dims = comp.rect ? `${Math.round(comp.rect.width)}×${Math.round(comp.rect.height)}px` : '';
  document.getElementById('preview-meta').textContent = `${comp.tag} · ${comp.category} · ${dims}`;

  // Screenshot
  const screenshotEl = document.getElementById('preview-screenshot');
  if (screenshotDataUrl) {
    screenshotEl.innerHTML = `<img src="${screenshotDataUrl}" alt="component preview" />`;
  } else {
    screenshotEl.innerHTML = `<div class="no-screenshot">No screenshot available</div>`;
  }

  // Interaction states arrive a moment later via INTERACTION_STATES — show a probing state for now
  renderPreviewInteractions('probing');

  // switchTab('components') already called renderComponents() before this
}

// Render the captured interaction states (or a probing/empty state) in the preview panel
function renderPreviewInteractions(status) {
  const el = document.getElementById('preview-interactions');
  if (!el) return;

  if (status === 'probing') {
    el.style.display = 'block';
    el.innerHTML = `<div class="interactions-label"><span class="spinner"></span> Probing interactions…</div>`;
    return;
  }
  if (!pendingInteractions.length) {
    el.style.display = 'block';
    el.innerHTML = `<div class="interactions-label">No extra interaction states detected</div>`;
    return;
  }

  el.style.display = 'block';
  const thumbs = pendingInteractions.map((s, i) => {
    const img = s.screenshot ? `<img src="${s.screenshot}" alt="state ${i + 1}" />` : '';
    return `<div class="interaction-thumb" title="${(s.trigger || '').replace(/"/g, '&quot;')}">${img}<span>${s.trigger || `state ${i + 1}`}</span></div>`;
  }).join('');
  el.innerHTML = `<div class="interactions-label">⚡ ${pendingInteractions.length} interaction state(s) captured — will be sent to AI</div>
    <div class="interaction-thumbs">${thumbs}</div>`;
}

function discardPreview() {
  pendingComponent = null;
  pendingScreenshot = null;
  pendingInteractions = [];
  document.getElementById('component-preview-panel').style.display = 'none';
  document.getElementById('preview-error').style.display = 'none';
  document.getElementById('reconstruct-result').style.display = 'none';
  const intEl = document.getElementById('preview-interactions');
  if (intEl) { intEl.style.display = 'none'; intEl.innerHTML = ''; }
}

// Open an HTML string in a new tab as a standalone preview
function previewInTab(html) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  chrome.tabs.create({ url });
}

// Strip the (large) screenshot dataUrls before persisting interaction specs
function interactionSpecsForStorage() {
  return pendingInteractions.map(s => ({
    trigger: s.trigger || null,
    addedNodes: s.addedNodes || [],
    attrChanges: s.attrChanges || [],
  }));
}

// Save the raw captured component (no AI)
async function saveRawComponent() {
  if (!pendingComponent) return;
  const comp = { ...pendingComponent, id: uid(), interactions: interactionSpecsForStorage() };
  if (pendingScreenshot) {
    await dbPut('screenshots', { id: comp.id, dataUrl: pendingScreenshot });
  }
  await dbPut('components', comp);
  discardPreview();
  await renderComponents();
  toast(`Saved ${comp.category}`);
}

// Save a reconstructed component (after AI)
async function saveReconstructedComponent(reconstructedHtml) {
  if (!pendingComponent) return;
  const comp = { ...pendingComponent, id: uid(), reconstructed: reconstructedHtml, interactions: interactionSpecsForStorage() };
  if (pendingScreenshot) {
    await dbPut('screenshots', { id: comp.id, dataUrl: pendingScreenshot });
  }
  await dbPut('components', comp);
  discardPreview();
  await renderComponents();
  toast(`Saved ${comp.category}`);
}

// Reconstruct with AI — on success shows the result panel with save/copy/preview options
async function reconstructCurrentComponent() {
  if (!pendingComponent) return;

  const errorEl = document.getElementById('preview-error');
  const resultEl = document.getElementById('reconstruct-result');
  errorEl.style.display = 'none';
  resultEl.style.display = 'none';

  const provider = await getAiProvider();
  const apiKey = provider === 'gemini' ? await getGeminiApiKey() : await getClaudeApiKey();
  if (!apiKey) {
    const providerName = provider === 'gemini' ? 'Gemini' : 'Claude';
    errorEl.textContent = `No API key found — add your ${providerName} API key in Settings ⚙`;
    errorEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btn-preview-reconstruct');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Reconstructing…';

  try {
    const reconstructed = await reconstructComponent(pendingComponent, pendingScreenshot, apiKey, provider, pendingInteractions);

    // Wire up result-panel buttons with the fresh HTML
    document.getElementById('btn-copy-reconstructed').onclick = () => copyText(reconstructed);
    document.getElementById('btn-preview-reconstructed').onclick = () => previewInTab(reconstructed);
    document.getElementById('btn-save-reconstructed').onclick = () => saveReconstructedComponent(reconstructed);

    resultEl.style.display = 'block';
  } catch (err) {
    errorEl.textContent = `Reconstruction failed: ${err.message}`;
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '✦ Reconstruct with AI';
  }
}

async function renderComponents() {
  const allComponents = await dbGetAll('components');
  const domainComponents = allComponents.filter(c => c.domain === currentDomain);

  const list = document.getElementById('component-list');
  const empty = document.getElementById('components-empty');
  const savedHeader = document.getElementById('saved-components-header');
  const hasPending = !!pendingComponent;

  if (domainComponents.length === 0) {
    list.style.display = 'none';
    savedHeader.style.display = 'none';
    // Only show empty state if there's no pending preview either
    empty.style.display = hasPending ? 'none' : 'flex';
    return;
  }

  empty.style.display = 'none';
  savedHeader.style.display = 'block';
  list.style.display = 'flex';
  list.innerHTML = '';

  const screenshots = await dbGetAll('screenshots');
  const screenshotMap = Object.fromEntries(screenshots.map(s => [s.id, s.dataUrl]));

  domainComponents.sort((a, b) => b.capturedAt - a.capturedAt).forEach(comp => {
    const card = document.createElement('div');
    card.className = 'component-card';
    const thumb = screenshotMap[comp.id];

    const thumbEl = thumb
      ? `<img class="component-thumb" src="${thumb}" alt="${comp.category}" />`
      : `<div class="component-thumb"></div>`;

    card.innerHTML = `
      ${thumbEl}
      <div class="component-info">
        <div class="component-category">${comp.category}</div>
        <div class="component-domain">${comp.tag} · ${comp.domain}</div>
        <div class="component-date">${formatDate(comp.capturedAt)}</div>
      </div>
      <button class="component-delete-btn" title="Delete">✕</button>
    `;

    // Click card body → open modal; click delete → remove
    card.querySelector('.component-info').addEventListener('click', () => openComponentModal(comp, thumb));
    card.querySelector('img, .component-thumb')?.addEventListener('click', () => openComponentModal(comp, thumb));
    card.querySelector('.component-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await dbDelete('components', comp.id);
      await dbDelete('screenshots', comp.id);
      await renderComponents();
    });

    list.appendChild(card);
  });
}

function openComponentModal(comp, thumb) {
  activeComponentId = comp.id;
  document.getElementById('modal-title').textContent =
    comp.category.charAt(0).toUpperCase() + comp.category.slice(1);

  // Screenshot
  const preview = document.getElementById('modal-preview');
  preview.innerHTML = thumb
    ? `<img src="${thumb}" alt="${comp.category}" style="width:100%;height:auto;display:block;" />`
    : `<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px">No screenshot</div>`;

  // Reset result panel
  const resultEl = document.getElementById('modal-reconstruct-result');
  resultEl.style.display = 'none';

  document.getElementById('component-modal').style.display = 'flex';

  // Show reconstructed result panel if already done previously
  if (comp.reconstructed) {
    resultEl.style.display = 'block';
    document.getElementById('btn-copy-output').onclick = () => copyText(comp.reconstructed);
    document.getElementById('btn-preview-output').onclick = () => previewInTab(comp.reconstructed);
  }

  // Copy HTML & CSS
  document.getElementById('btn-copy-html').onclick = () =>
    copyText(`<!-- HTML -->\n${comp.html}\n\n/* CSS */\n${comp.css}`);

  // Preview raw in new tab
  document.getElementById('btn-preview-html').onclick = () =>
    previewInTab(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;}
${comp.css}</style></head><body><div>${comp.html}</div></body></html>`);
}

// ─────────────────────────────────────────────
// MOODBOARD
// ─────────────────────────────────────────────

// Collect all tags for a site entry as a flat string array
function getAllTagsForSite(siteData) {
  const manual = siteData.tags || [];
  const ai = siteData.aiTags ? Object.values(siteData.aiTags).flat() : [];
  return [...manual, ...ai];
}

// Build one site card element
function buildSiteCard(domain, siteData, screenshotMap, components, query) {
  const allTags = getAllTagsForSite(siteData);
  const styles = siteData.styles || {};

  const card = document.createElement('div');
  card.className = 'mb-site-card';
  card.dataset.domain = domain;

  // ── Summary row ──────────────────────────────
  const summary = document.createElement('div');
  summary.className = 'mb-site-summary';

  // Favicon
  const favicon = document.createElement('img');
  favicon.className = 'mb-site-favicon';
  favicon.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  favicon.onerror = () => { favicon.style.display = 'none'; };

  // Domain name
  const domainEl = document.createElement('span');
  domainEl.className = 'mb-site-domain';
  domainEl.textContent = domain;

  // Color dot strip (top 5)
  const swatches = document.createElement('div');
  swatches.className = 'mb-site-swatches';
  (styles.colors?.smart || []).slice(0, 5).forEach(c => {
    const dot = document.createElement('div');
    dot.className = 'mb-swatch-dot';
    dot.style.background = c.hex;
    dot.title = c.hex;
    swatches.appendChild(dot);
  });

  // Tags (highlight matches)
  const tagsWrap = document.createElement('div');
  tagsWrap.className = 'mb-summary-tags';
  allTags.slice(0, 3).forEach(tag => {
    const t = document.createElement('span');
    t.className = 'mb-tag' + (query && tag.toLowerCase().includes(query) ? ' highlight' : '');
    t.textContent = tag;
    tagsWrap.appendChild(t);
  });

  // Date
  const dateEl = document.createElement('span');
  dateEl.className = 'mb-site-date';
  dateEl.textContent = formatDate(siteData.updatedAt || 0);

  // Chevron
  const chevron = document.createElement('span');
  chevron.className = 'mb-chevron';
  chevron.textContent = '▾';

  summary.appendChild(favicon);
  summary.appendChild(domainEl);
  summary.appendChild(swatches);
  summary.appendChild(tagsWrap);
  summary.appendChild(dateEl);
  summary.appendChild(chevron);

  // ── Detail panel ─────────────────────────────
  const detail = document.createElement('div');
  detail.className = 'mb-site-detail';

  function makeSection(label) {
    const sec = document.createElement('div');
    sec.className = 'mb-detail-section';
    const lbl = document.createElement('div');
    lbl.className = 'mb-detail-label';
    lbl.textContent = label;
    sec.appendChild(lbl);
    return sec;
  }

  // ── CSS Variables / Design Tokens
  const vars = styles.cssVariables || {};
  if (Object.keys(vars).length) {
    const sec = makeSection(`Design Tokens (${Object.keys(vars).length})`);
    sec.appendChild(buildTokenGroupsEl(vars));
    detail.appendChild(sec);
  }

  // ── Colors (smart + toggle to full)
  if (styles.colors?.smart?.length) {
    const sec = makeSection('Colors');
    const header = sec.querySelector('.mb-detail-label');

    let showingFull = false;
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'toggle-btn';
    toggleBtn.textContent = 'Show all';
    toggleBtn.style.marginLeft = '8px';
    header.appendChild(toggleBtn);

    function makeSwatchRow(colorList) {
      const row = document.createElement('div');
      row.className = 'mb-color-row';
      colorList.forEach(c => {
        const sw = document.createElement('div');
        sw.className = 'mb-color-swatch';
        sw.style.background = c.hex;
        sw.title = c.hex;
        sw.addEventListener('click', () => copyText(c.hex));
        row.appendChild(sw);
      });
      return row;
    }

    const smartRow = makeSwatchRow(styles.colors.smart);
    const fullRow = makeSwatchRow(styles.colors.full || styles.colors.smart);
    fullRow.style.display = 'none';

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showingFull = !showingFull;
      smartRow.style.display = showingFull ? 'none' : 'flex';
      fullRow.style.display = showingFull ? 'flex' : 'none';
      toggleBtn.textContent = showingFull ? 'Show smart' : 'Show all';
    });

    sec.appendChild(smartRow);
    sec.appendChild(fullRow);
    detail.appendChild(sec);
  }

  // ── Typography
  const typo = styles.typography || {};
  if (typo.fontFamilies?.length) {
    const sec = makeSection('Typography');
    sec.appendChild(buildTypographyEl(typo));
    detail.appendChild(sec);
  }

  // ── Spacing
  if (styles.spacing?.length) {
    const sec = makeSection('Spacing');
    const chips = document.createElement('div');
    chips.className = 'chip-row';
    styles.spacing.forEach(v => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = v;
      chip.addEventListener('click', () => copyText(v));
      chips.appendChild(chip);
    });
    sec.appendChild(chips);
    detail.appendChild(sec);
  }

  // ── Border Radius
  if (styles.borderRadii?.length) {
    const sec = makeSection('Border Radius');
    const chips = document.createElement('div');
    chips.className = 'chip-row';
    styles.borderRadii.forEach(v => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = v;
      chip.addEventListener('click', () => copyText(v));
      chips.appendChild(chip);
    });
    sec.appendChild(chips);
    detail.appendChild(sec);
  }

  // ── Shadows
  if (styles.shadows?.length) {
    const sec = makeSection('Shadows');
    const list = document.createElement('div');
    list.className = 'shadow-list';
    styles.shadows.forEach(s => {
      const item = document.createElement('div');
      item.className = 'shadow-item';
      item.style.cursor = 'pointer';
      item.innerHTML = `
        <div class="shadow-demo" style="box-shadow:${s}"></div>
        <div class="shadow-value">${s}</div>
      `;
      item.addEventListener('click', () => copyText(s));
      list.appendChild(item);
    });
    sec.appendChild(list);
    detail.appendChild(sec);
  }

  // ── Components
  const siteComps = components.filter(c => c.domain === domain);
  if (siteComps.length) {
    const sec = makeSection(`Components (${siteComps.length})`);
    const row = document.createElement('div');
    row.className = 'mb-component-row';
    siteComps.forEach(comp => {
      const thumb = screenshotMap[comp.id];
      const wrap = document.createElement('div');
      wrap.className = 'mb-component-thumb-wrap';
      wrap.innerHTML = `
        ${thumb ? `<img class="mb-component-img" src="${thumb}" alt="${comp.category}" />` : `<div class="mb-component-img"></div>`}
        <div class="mb-component-label">${comp.category}</div>
      `;
      wrap.addEventListener('click', () => openComponentModal(comp, thumb));
      row.appendChild(wrap);
    });
    sec.appendChild(row);
    detail.appendChild(sec);
  }

  // ── All tags (full list)
  if (allTags.length) {
    const sec = makeSection('Tags');
    const tagRow = document.createElement('div');
    tagRow.className = 'chip-row';
    allTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (query && tag.toLowerCase().includes(query) ? ' highlight' : '');
      chip.textContent = tag;
      tagRow.appendChild(chip);
    });
    sec.appendChild(tagRow);
    detail.appendChild(sec);
  }

  // ── Notes + Auto-generate tags
  const notesSec = makeSection('Notes');

  const textarea = document.createElement('textarea');
  textarea.className = 'mb-notes-textarea';
  textarea.placeholder = 'What do you love about this site? e.g. "Rounded corners, very Apple bento feel…"';
  textarea.value = siteData.notes || '';

  const savedLabel = document.createElement('div');
  savedLabel.className = 'mb-notes-saved';

  let saveTimer;
  textarea.addEventListener('input', () => {
    clearTimeout(saveTimer);
    savedLabel.textContent = '';
    saveTimer = setTimeout(async () => {
      await saveSiteData(domain, { notes: textarea.value });
      savedLabel.textContent = 'Saved';
      setTimeout(() => { savedLabel.textContent = ''; }, 1800);
    }, 600);
  });

  // Auto-generate tags button
  const genRow = document.createElement('div');
  genRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap;';

  const genBtn = document.createElement('button');
  genBtn.className = 'btn-secondary';
  genBtn.style.fontSize = '11px';
  genBtn.innerHTML = '✦ Auto-generate tags from notes';

  const genStatus = document.createElement('span');
  genStatus.style.cssText = 'font-size:11px; color:var(--text-dim);';

  genBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const provider = await getAiProvider();
    const apiKey = provider === 'gemini' ? await getGeminiApiKey() : await getClaudeApiKey();
    if (!apiKey) {
      const providerName = provider === 'gemini' ? 'Gemini' : 'Claude';
      genStatus.style.color = 'var(--danger)';
      genStatus.textContent = `API key not found — add your ${providerName} key in Settings`;
      return;
    }

    const notesText = textarea.value.trim();
    if (!notesText) {
      genStatus.style.color = 'var(--text-dim)';
      genStatus.textContent = 'Write some notes first';
      return;
    }

    genBtn.disabled = true;
    genStatus.style.color = 'var(--text-dim)';
    genStatus.innerHTML = '<span class="spinner"></span> Generating…';

    try {
      const prompt = `From these design notes about ${domain}, extract concise tags that describe the aesthetic, mood, and design decisions.

Notes: "${notesText}"

Return ONLY a JSON array of short lowercase tag strings (max 8 tags). Examples: ["bento-grid","rounded","minimal","apple-inspired","pastel"]
No explanation, no markdown.`;

      const raw = await callLLM(
        'You are a design analyst. Respond only with a valid JSON array of strings.',
        prompt,
        apiKey,
        provider
      );

      const match = raw.match(/\[[\s\S]*?\]/);
      if (!match) throw new Error('No tags returned');
      const newTags = JSON.parse(match[0]);

      // Merge with existing manual tags, deduplicate
      const existing = siteData.tags || [];
      const merged = [...new Set([...existing, ...newTags])];
      await saveSiteData(domain, { tags: merged });

      genStatus.style.color = 'var(--success)';
      genStatus.textContent = `Added: ${newTags.join(', ')}`;

      // Refresh this card in the list
      renderMoodboard(document.getElementById('mb-search')?.value || '');
    } catch (err) {
      genStatus.style.color = 'var(--danger)';
      genStatus.textContent = `Error: ${err.message}`;
    } finally {
      genBtn.disabled = false;
    }
  });

  genRow.appendChild(genBtn);
  genRow.appendChild(genStatus);

  notesSec.appendChild(textarea);
  notesSec.appendChild(savedLabel);
  notesSec.appendChild(genRow);
  detail.appendChild(notesSec);

  // ── Toggle expand/collapse ────────────────────
  summary.addEventListener('click', () => {
    const isExpanded = card.classList.contains('expanded');
    card.classList.toggle('expanded', !isExpanded);
  });

  card.appendChild(summary);
  card.appendChild(detail);
  return card;
}

async function renderMoodboard(query = '') {
  const sites = await getAllSites();
  const domains = Object.keys(sites);

  const empty = document.getElementById('moodboard-empty');
  const noResults = document.getElementById('mb-no-results');
  const list = document.getElementById('mb-site-list');
  list.innerHTML = '';

  if (domains.length === 0) {
    empty.style.display = 'flex';
    noResults.style.display = 'none';
    return;
  }
  empty.style.display = 'none';

  // Pre-load components + screenshots once
  const allComponents = await dbGetAll('components');
  const screenshots = await dbGetAll('screenshots');
  const screenshotMap = Object.fromEntries(screenshots.map(s => [s.id, s.dataUrl]));

  // Filter by query
  const q = query.trim().toLowerCase();
  const filtered = domains.filter(domain => {
    if (!q) return true;
    const siteData = sites[domain];
    const tags = getAllTagsForSite(siteData);
    return domain.toLowerCase().includes(q) || tags.some(t => t.toLowerCase().includes(q));
  });

  if (filtered.length === 0) {
    noResults.style.display = 'block';
    document.getElementById('mb-no-results-text').textContent = `No results for "${query}"`;
    return;
  }
  noResults.style.display = 'none';

  // Sort by most recently updated
  filtered
    .sort((a, b) => (sites[b].updatedAt || 0) - (sites[a].updatedAt || 0))
    .forEach(domain => {
      const card = buildSiteCard(domain, sites[domain], screenshotMap, allComponents, q);
      list.appendChild(card);

      // Kick off AI tag generation in background if needed
      const siteData = sites[domain];
      if (!siteData.aiTags && siteData.styles) {
        (async () => {
          const provider = await getAiProvider();
          const apiKey = provider === 'gemini' ? await getGeminiApiKey() : await getClaudeApiKey();
          if (apiKey) generateTagsForSite(domain, siteData, apiKey, provider);
        })();
      }
    });
}

async function generateTagsForSite(domain, siteData, apiKey, provider) {
  try {
    const aiTags = await generateTags(siteData.styles, apiKey, provider);
    await saveSiteData(domain, { aiTags });
    // Refresh the specific card's tags without full re-render
    renderMoodboard(document.getElementById('mb-search')?.value || '');
  } catch (err) {
    console.warn('Tag generation failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// ACTIVE TAB TRACKING
// ─────────────────────────────────────────────

function resetUI() {
  currentExtractedData = null;

  // Styles tab → empty state
  document.getElementById('styles-empty').style.display = 'flex';
  document.getElementById('styles-content').style.display = 'none';
  document.getElementById('styles-tags-input').value = '';
  document.getElementById('section-tokens').style.display = 'none';
  document.getElementById('section-shadows').style.display = 'none';

  // Components tab → reset preview + list
  pendingComponent = null;
  pendingScreenshot = null;
  pendingInteractions = [];
  document.getElementById('component-preview-panel').style.display = 'none';
  document.getElementById('saved-components-header').style.display = 'none';
  document.getElementById('components-empty').style.display = 'flex';
  document.getElementById('component-list').style.display = 'none';
  document.getElementById('picker-status').textContent = '';
  const pickBtn = document.getElementById('btn-pick-component');
  pickBtn.classList.remove('active');
  pickBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l4 10 2-4 4-2L1 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="7" y1="7" x2="13" y2="13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
    Pick Component`;

  // Moodboard tab → clear list, search will repopulate on tab switch
  document.getElementById('mb-site-list').innerHTML = '';
  document.getElementById('moodboard-empty').style.display = 'none';
  document.getElementById('mb-no-results').style.display = 'none';
}

async function updateSiteContext(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return;

    // Skip blob:/data: tabs — these are preview tabs we opened ourselves
    if (tab.url.startsWith('blob:') || tab.url.startsWith('data:')) return;

    // Non-web tabs (extensions, devtools, chrome://)
    if (!tab.url.startsWith('http')) {
      currentTabId = tabId;
      document.getElementById('site-domain').textContent = '—';
      document.getElementById('site-favicon').src = '';
      currentDomain = null;
      return;
    }

    const newDomain = new URL(tab.url).hostname;

    // Only reset state when actually navigating to a different site
    if (newDomain !== currentDomain) {
      currentTabId = tabId;
      currentDomain = newDomain;
      resetUI();
      document.getElementById('site-domain').textContent = currentDomain;
      document.getElementById('site-favicon').src = `https://www.google.com/s2/favicons?domain=${currentDomain}&sz=32`;
    } else {
      // Same domain, just update the tracked tab id
      currentTabId = tabId;
    }
  } catch { }
}

async function getCurrentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

// ─────────────────────────────────────────────
// SETTINGS UI
// ─────────────────────────────────────────────

async function openSettings() {
  document.getElementById('settings-panel').style.display = 'flex';
  const claudeKey = await getClaudeApiKey();
  const geminiKey = await getGeminiApiKey();
  const provider = await getAiProvider();
  document.getElementById('input-claude-key').value = claudeKey;
  document.getElementById('input-gemini-key').value = geminiKey;
  document.getElementById('select-ai-provider').value = provider;
  await renderSavedSitesList();
}

function closeSettings() {
  document.getElementById('settings-panel').style.display = 'none';
}

async function renderSavedSitesList() {
  const sites = await getAllSites();
  const list = document.getElementById('saved-sites-list');
  list.innerHTML = '';
  const domains = Object.keys(sites);
  if (domains.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:4px 0">No saved sites yet</div>';
    return;
  }
  domains.forEach(domain => {
    const row = document.createElement('div');
    row.className = 'saved-site-row';
    row.innerHTML = `
      <span>${domain}</span>
      <button data-domain="${domain}" title="Delete">✕</button>
    `;
    row.querySelector('button').addEventListener('click', async (e) => {
      const d = e.target.dataset.domain;
      await deleteSite(d);
      await renderSavedSitesList();
      toast(`Removed ${d}`);
    });
    list.appendChild(row);
  });
}

// ─────────────────────────────────────────────
// SAFE MESSAGE TO CONTENT SCRIPT
// Re-injects content.js if the receiving end doesn't exist yet
// (happens on tabs that were open before the extension was loaded)
// ─────────────────────────────────────────────

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (!err.message?.includes('Receiving end does not exist')) throw err;

    // Content script not running — inject it now
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (injectErr) {
      // Restricted page (chrome://, extensions page, etc.)
      throw new Error('This page cannot be accessed by extensions');
    }

    // Give it a moment to register its message listener
    await new Promise(r => setTimeout(r, 150));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// ─────────────────────────────────────────────
// EVENT WIRING
// ─────────────────────────────────────────────

function wireEvents() {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Extract button
  document.getElementById('btn-extract').addEventListener('click', async () => {
    if (!currentTabId) return;
    const btn = document.getElementById('btn-extract');
    btn.classList.add('loading');
    btn.textContent = 'Reading…';
    try {
      const response = await sendToTab(currentTabId, { type: 'EXTRACT_STYLES' });
      if (response?.ok) {
        renderStyles(response.data);
        switchTab('styles');
        toast('Design tokens extracted');
      } else {
        toast(response?.error || 'Extraction failed');
      }
    } catch (err) {
      toast('Could not read this page');
      console.error(err);
    } finally {
      btn.classList.remove('loading');
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1v8M3 6l3.5 3.5L10 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 11h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        Extract`;
    }
  });

  // Save design system
  document.getElementById('btn-save-styles').addEventListener('click', async () => {
    if (!currentExtractedData || !currentDomain) {
      toast('Extract styles first');
      return;
    }
    const tagsRaw = document.getElementById('styles-tags-input').value;
    const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
    await saveSiteData(currentDomain, { styles: currentExtractedData, tags });
    toast(`Saved ${currentDomain}`);
  });

  // Moodboard search
  const mbSearch = document.getElementById('mb-search');
  const mbClear = document.getElementById('mb-search-clear');
  mbSearch.addEventListener('input', () => {
    const q = mbSearch.value;
    mbClear.style.display = q ? 'inline' : 'none';
    renderMoodboard(q);
  });
  mbClear.addEventListener('click', () => {
    mbSearch.value = '';
    mbClear.style.display = 'none';
    renderMoodboard('');
  });

  // Settings
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-close-settings').addEventListener('click', closeSettings);

  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const claudeKey = document.getElementById('input-claude-key').value.trim();
    const geminiKey = document.getElementById('input-gemini-key').value.trim();
    const provider = document.getElementById('select-ai-provider').value;
    await saveSettings(claudeKey, geminiKey, provider);
    toast('Settings saved');
    closeSettings();
  });

  document.getElementById('btn-clear-all').addEventListener('click', async () => {
    if (!confirm('Delete all saved data? This cannot be undone.')) return;
    await chrome.storage.local.clear();
    const allComponents = await dbGetAll('components');
    for (const c of allComponents) await dbDelete('components', c.id);
    const allScreenshots = await dbGetAll('screenshots');
    for (const s of allScreenshots) await dbDelete('screenshots', s.id);
    toast('All data cleared');
    closeSettings();
  });

  // Component picker
  document.getElementById('btn-pick-component').addEventListener('click', async () => {
    if (!currentTabId) return;
    const btn = document.getElementById('btn-pick-component');
    const status = document.getElementById('picker-status');

    if (btn.classList.contains('active')) {
      // Cancel picker
      await sendToTab(currentTabId, { type: 'STOP_PICKER' }).catch(() => { });
      btn.classList.remove('active');
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l4 10 2-4 4-2L1 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="7" y1="7" x2="13" y2="13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        Pick Component`;
      status.textContent = '';
    } else {
      await sendToTab(currentTabId, { type: 'START_PICKER' }).catch(() => { });
      btn.classList.add('active');
      btn.textContent = 'Cancel';
      status.textContent = 'Hover over an element and click…';
    }
  });

  // Preview panel buttons
  document.getElementById('btn-discard-preview').addEventListener('click', discardPreview);
  document.getElementById('btn-preview-copy').addEventListener('click', () => {
    if (pendingComponent) copyText(
      `<!-- HTML -->\n${pendingComponent.html}\n\n/* CSS */\n${pendingComponent.css}`
    );
  });
  document.getElementById('btn-preview-preview').addEventListener('click', () => {
    if (!pendingComponent) return;
    previewInTab(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;}
${pendingComponent.css}</style></head><body><div>${pendingComponent.html}</div></body></html>`);
  });
  document.getElementById('btn-save-component').addEventListener('click', saveRawComponent);
  document.getElementById('btn-preview-reconstruct').addEventListener('click', reconstructCurrentComponent);

  // Modal close
  document.getElementById('modal-close').addEventListener('click', () => {
    document.getElementById('component-modal').style.display = 'none';
  });
  document.getElementById('component-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('component-modal')) {
      document.getElementById('component-modal').style.display = 'none';
    }
  });

  // Dedicated request/response listener for the interaction planner. Kept
  // separate from the async listener below so we can return true and respond
  // asynchronously (Chrome doesn't support that from an async listener).
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'PROBE_PLAN') return; // other listener handles the rest
    (async () => {
      try {
        const plan = await computeProbePlan(message);
        sendResponse({ ok: !!plan, plan: plan || [] });
      } catch (err) {
        console.warn('[atomic-strip] plan failed:', err);
        sendResponse({ ok: false, plan: [] });
      }
    })();
    return true; // keep the channel open for the async sendResponse
  });

  // Background messages (from content script / tab events)
  chrome.runtime.onMessage.addListener(async (message) => {
    switch (message.type) {
      case 'TAB_CHANGED':
      case 'TAB_UPDATED':
        await updateSiteContext(message.tabId);
        break;

      case 'ELEMENT_CAPTURED': {
        // Ignore the original broadcast from the content script — only handle
        // the enriched copy that background forwards after attaching the screenshot
        if (!message._forwarded) break;

        const btn = document.getElementById('btn-pick-component');
        btn.classList.remove('active');
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l4 10 2-4 4-2L1 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="7" y1="7" x2="13" y2="13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Pick Component`;

        const comp = message.data;

        let croppedDataUrl = null;
        if (message.screenshotDataUrl && comp.rect) {
          const dpr = comp.devicePixelRatio || 1;
          croppedDataUrl = await cropScreenshot(message.screenshotDataUrl, comp.rect, dpr);
        }

        switchTab('components');
        showComponentPreview(comp, croppedDataUrl);
        document.getElementById('picker-status').textContent = '';
        break;
      }

      // Interaction probe finished in the page — attach revealed states to the
      // pending component so "Reconstruct with AI" can include them.
      case 'INTERACTION_STATES': {
        if (!pendingComponent) break;
        // Match the states to the component currently in preview (capturedAt === captureId)
        if (message.captureId != null && pendingComponent.capturedAt != null &&
            message.captureId !== pendingComponent.capturedAt) break;
        pendingInteractions = Array.isArray(message.states) ? message.states : [];
        renderPreviewInteractions('done');
        break;
      }

      case 'PICKER_CANCELLED': {
        const btn = document.getElementById('btn-pick-component');
        btn.classList.remove('active');
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l4 10 2-4 4-2L1 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="7" y1="7" x2="13" y2="13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Pick Component`;
        document.getElementById('picker-status').textContent = '';
        break;
      }
    }
  });
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

async function init() {
  await openDB();
  wireEvents();

  const tabId = await getCurrentTabId();
  if (tabId) await updateSiteContext(tabId);
}

document.addEventListener('DOMContentLoaded', init);
