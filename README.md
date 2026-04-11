# Atomic Strip

A Chrome extension for designers and frontend developers to capture and save design systems from any website they visit.

Extract colors, typography, and design tokens. Pick individual components. Reconstruct them with AI. Build a searchable library of visual inspiration.

---

## How to run

1. Clone or download this folder
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `atomic-strip` folder
5. Click the extension icon in the toolbar — the side panel opens

To use AI features (component reconstruction, tag generation), add a Claude API key in the extension's Settings panel.

---

## Features

### Styles tab
- Extracts CSS custom properties (design tokens), grouped by prefix and collapsible
- Clusters color palette — smart view (top 10 perceptually distinct colors) with toggle to full list
- Typography: font families with specimens, weight chips, size scale, line heights
- Spacing scale, border radii, box shadows
- Save the full design system against the current site with manual tags

### Components tab
- **Element picker** — click any element on the page to select it; hover highlights with purple outline; `↑ / ↓` arrow keys traverse the DOM; `Esc` cancels
- After picking: screenshot preview, Copy HTML & CSS, Preview in new tab, Save (raw), or Reconstruct with AI
- **Reconstruct with AI** sends HTML, filtered CSS (with resolved variables), and the screenshot to Claude, which produces a clean self-contained HTML file with vanilla JS interactions
- Saved components listed below, per-site, with thumbnails and a delete button on hover
- Clicking a saved component opens a modal with copy / preview / reconstructed result

### Moodboard tab
- Shows all saved sites as a searchable card library
- **Search** filters by domain name or any tag (manual or AI-generated) in real time
- Each card shows: favicon, color dot strip, up to 3 tag chips, date saved
- **Expand** any card to see the full design system: tokens, colors, fonts, spacing, radii, shadows, saved components
- **Notes** field per site — auto-saves 600ms after typing
- **Auto-generate tags** from notes — sends your written observations to Claude and returns tags like `bento-grid`, `minimal`, `apple-inspired`; merged with existing tags

---

## Architecture

```
manifest.json         Chrome MV3 config
background.js         Service worker: tab tracking, screenshot timing, message routing
content.js            Injected into pages: style extraction + interactive element picker
sidepanel.html        UI layout: 3 tabs + settings + component modal
sidepanel.css         Dark theme (bg #0D0D10, accent #7B68EE)
sidepanel.js          All logic: rendering, storage, Claude API
icons/                16 / 48 / 128px PNGs
```

### Data flow

```
Extract styles:
  sidepanel → content.js (EXTRACT_STYLES) → returns computed styles → renderStyles()

Pick component:
  sidepanel → content.js (START_PICKER) → user clicks element
  → content.js sends ELEMENT_CAPTURED → background.js
  → background waits 120ms, takes screenshot, re-broadcasts with _forwarded:true
  → sidepanel crops screenshot to element rect → shows preview panel

Save component:
  sidepanel → IndexedDB: components store (HTML/CSS/meta) + screenshots store (PNG dataUrl)

Save design system:
  sidepanel → chrome.storage.local: sites[domain] = { styles, tags, aiTags, notes }
```

### Storage

| Data | Where | Why |
|---|---|---|
| Design system (styles, tags, notes) | `chrome.storage.local` | Fast, structured |
| Component HTML/CSS/metadata | `chrome.storage.local` via IndexedDB `components` | Queryable |
| Screenshots (PNG blobs) | IndexedDB `screenshots` | Binary, no size limit |
| API key | `chrome.storage.local` | Persists across sessions |

---

## Using AI features

Add your Claude API key in the Settings panel (⚙ icon).

**Component reconstruction** (`claude-opus-4-6`): Given the element's HTML, filtered and resolved CSS, and a screenshot, Claude produces a single self-contained `.html` file. It infers interactions (hover states, toggles, dropdowns) from the HTML structure and writes clean vanilla JS.

**Tag generation** (`claude-opus-4-6`): Given color palette, typography, and domain, Claude suggests aesthetic tags (`brutalist`, `glassmorphism`, `bento-grid`), mood, color character, type character, and industry.

**Note-to-tags**: Takes your written observation about a site and extracts design vocabulary tags from it.

If no API key is set, a clear inline error appears at the point of action.

---

## Future scope

### Near-term
- **Behavior recording** — After picking a component, enter a short record mode where clicking/hovering the element generates a compact JSON spec of DOM/class/ARIA state changes. Pass this to Claude instead of raw JS for accurate interaction reconstruction.
- **Framework introspection** — Read `__reactFiber`, `__vue__`, `_x_dataStack` on the selected DOM node to extract event handler source before minification obscures it.

### Medium-term
- **Export** — Download a saved design system as a JSON/CSS file or Figma-compatible tokens format
- **Cross-device sync** — Backend storage (Supabase or similar) so saved systems follow you across machines
- **Collections** — Group saved sites into named boards ("SaaS dashboards", "Brutalist inspo")
- **Component search** — Search across saved components by category, domain, or tag

### Long-term
- **Source map extraction** — Detect `//# sourceMappingURL=` in page scripts, fetch source maps, extract only the component-relevant file to provide readable JS to Claude
- **Firefox / Safari support** — `sidePanel` API is Chrome-only; would require different UI approach
- **Team sharing** — Share a saved design system with a link

---

## Known constraints

- `captureVisibleTab` requires the literal `<all_urls>` host permission — split `http://*/*` + `https://*/*` patterns do not satisfy it in Chrome
- The element picker overlay uses `z-index: 2147483647` (maximum) but can still be covered by elements using CSS transforms or Shadow DOM
- Component reconstruction quality depends on how well the site uses semantic HTML and ARIA — React apps with cryptic class names give the LLM less to work with
- Screenshots of components with dynamic content (carousels, live data) capture only the current state
