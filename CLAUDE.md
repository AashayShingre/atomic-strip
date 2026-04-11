# CLAUDE.md — Atomic Strip

## What this is

A Chrome extension (Manifest V3) that extracts and saves design systems from live websites. Designers and frontend developers use it to capture inspiration while browsing — colors, typography, spacing, components — and search across everything saved.

Three tabs: **Styles** (extracted design tokens), **Components** (picked UI elements), **Moodboard** (searchable library of all saved sites).

---

## File map

| File | Role |
|---|---|
| `manifest.json` | MV3 config — permissions, side panel, content script |
| `background.js` | Service worker — tab tracking, screenshot capture, message routing |
| `content.js` | Injected into pages — style extraction + element picker |
| `sidepanel.html` | UI shell — 3 tabs, settings panel, component modal |
| `sidepanel.css` | Dark theme UI, purple accent (`#7B68EE`) |
| `sidepanel.js` | All logic — rendering, storage, Claude API calls |
| `icons/` | 16/48/128px atom PNGs |

---

## Architecture

```
Browser Tab (content.js)
  → extracts styles via getComputedStyle + document.styleSheets
  → runs element picker (overlay + MutationObserver-less hit testing)
  → sends ELEMENT_CAPTURED to background.js

background.js (service worker)
  → on ELEMENT_CAPTURED: takes screenshot via captureVisibleTab (120ms delay for repaint)
  → attaches screenshot to message, sets _forwarded:true, re-broadcasts
  → prevents infinite loop: ignores _forwarded messages

sidepanel.js (side panel)
  → only handles ELEMENT_CAPTURED when _forwarded:true
  → crops screenshot to element rect using canvas + devicePixelRatio from content
  → shows preview panel (not saved yet)
  → on save: writes to IndexedDB (components + screenshots stores)
  → site-level data (styles, tags, notes) in chrome.storage.local
```

---

## Storage model

**`chrome.storage.local`**
```
{
  apiKey: "sk-ant-...",
  sites: {
    "stripe.com": {
      styles: { colors, typography, spacing, borderRadii, shadows, cssVariables },
      tags: ["minimal", "saas"],          // manual tags
      aiTags: { aesthetic, mood, colorChar, typeChar, industry },  // Claude-generated
      notes: "Love the rounded corners...",
      updatedAt: 1712345678000
    }
  }
}
```

**IndexedDB** (`atomic-strip` db, v1)
- `components` store — `{ id, html, css, rect, tag, category, fontFamilies, url, domain, capturedAt, devicePixelRatio, reconstructed? }`
- `screenshots` store — `{ id, dataUrl }` — blob data lives here (too large for chrome.storage)

---

## Message flow (critical)

Content → Background: `ELEMENT_CAPTURED { data, type }`
Background → All: `ELEMENT_CAPTURED { data, type, screenshotDataUrl, _forwarded: true }`

Side panel ignores any `ELEMENT_CAPTURED` without `_forwarded: true` to avoid double-handling (content.js broadcasts to everyone, background forwards enriched copy).

`sendToTab()` in sidepanel.js handles "Receiving end does not exist" by re-injecting content.js via `chrome.scripting.executeScript` and retrying.

---

## Claude API usage

Three calls, all using `claude-opus-4-6`, max 4096 tokens:

1. **reconstructComponent(comp, screenshotDataUrl, apiKey)**
   - Input: outerHTML + filtered CSS (resolved vars) + screenshot + font list
   - Output: single self-contained `.html` file (no markdown, no explanation)
   - Goal: replicate look + infer/implement interactions in vanilla JS

2. **generateTags(stylesData, apiKey)**
   - Input: color hexes, font families, size range, border radii, domain
   - Output: `{ aesthetic[], mood[], colorChar[], typeChar[], industry[] }` JSON
   - Used on moodboard when site is first saved

3. **Note-to-tags (inline in buildSiteCard)**
   - Input: notes textarea content + domain
   - Output: flat string array of up to 8 tags
   - Merges with existing manual tags, deduplicates

API key stored in `chrome.storage.local`. If absent, inline error shown (not toast) at the point of action.

---

## Key patterns

**Color clustering** — `clusterColors()` uses HSL distance (threshold 0.18) not RGB, so perceptually similar colors group correctly. Returns `{ smart: top10, full: all }`.

**CSS variable resolution** — `getRelevantCSS()` replaces `var(--x)` with computed values inline before sending to LLM. LLM never sees unresolved tokens.

**Token grouping** — `groupTokens(vars)` splits `--_aqua-810` → group `aqua`. Rendered as collapsible rows in both Styles tab and Moodboard.

**Shared renderers** — `buildTokenGroupsEl(vars)` and `buildTypographyEl(typo)` are used by both the Styles tab and Moodboard detail panels. Both tabs must look identical — if you change one, use the shared helper.

**Site reset** — `updateSiteContext()` only calls `resetUI()` when the domain actually changes. Skips `blob:` and `data:` URLs (these are preview tabs the extension itself opened).

**Screenshot DPR** — `devicePixelRatio` is captured in `content.js` and sent with the element data. Cropping in `sidepanel.js` uses `comp.devicePixelRatio || 1` — not `window.devicePixelRatio` from the side panel context.

**Component categories** — Auto-detected from tag + ARIA role + class names: `nav`, `header`, `footer`, `card`, `button`, `modal`, `form`, or `component` fallback.

**Picker hit-testing** — Transparent overlay captures mouse events; on mousemove, overlay's `pointerEvents` is briefly set to `none`, `elementFromPoint` runs, then re-enabled. Prevents the overlay from blocking the real element detection.

---

## What is NOT done yet (planned)

- **Behavior recording** (Phase 2 of interactions plan) — MutationObserver records DOM/class/ARIA state changes while user demonstrates interactions; compact JSON spec passed to LLM alongside HTML/CSS
- **Framework introspection** (Phase 1 of interactions plan) — Read `__reactFiber`, `__vue__`, `_x_dataStack` on selected element to surface event handler source
- **Cross-device sync** — Currently all storage is local; Supabase/Firebase backend planned
- **Export** — No way to export a saved design system as a file yet
- **Browser support** — Only Chrome; `sidePanel` API not available in Firefox/Safari

---

## Dev notes

- Reload at `chrome://extensions` after any file change
- Check background service worker console at `chrome://extensions` → "Inspect views: service worker"
- Check side panel console by right-clicking inside the panel → Inspect
- Check content script logs in the page's DevTools console
- `captureVisibleTab` requires `<all_urls>` in `host_permissions` — `http://*/*` + `https://*/*` do NOT satisfy it
- The 120ms delay in background.js before `captureVisibleTab` is intentional — gives the picker overlay one repaint to disappear before the screenshot fires
