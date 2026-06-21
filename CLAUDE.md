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
| `sidepanel.js` | All logic — rendering, storage, Claude API calls, agentic reconstruction loop |
| `vendor/html2canvas.min.js` | DOM→canvas rasterizer — used to screenshot the generated component for visual self-verification |
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
- `components` store — `{ id, html, css, rect, tag, category, fontFamilies, url, domain, capturedAt, devicePixelRatio, reconstructed?, interactions? }` (`interactions` = probe specs: `[{ trigger, addedNodes, attrChanges }]`, images stripped)
- `screenshots` store — `{ id, dataUrl }` — blob data lives here (too large for chrome.storage)

---

## Message flow (critical)

Content → Background: `ELEMENT_CAPTURED { data, type }` (data.capturedAt is the captureId)
Background → All: `ELEMENT_CAPTURED { data, type, screenshotDataUrl, _forwarded: true }`

Side panel ignores any `ELEMENT_CAPTURED` without `_forwarded: true` to avoid double-handling (content.js broadcasts to everyone, background forwards enriched copy).

`sendToTab()` in sidepanel.js handles "Receiving end does not exist" by re-injecting content.js via `chrome.scripting.executeScript` and retrying.

### Interaction probe (heuristic — runs at RECONSTRUCT time, not at pick)

The sweep is **deferred**: `captureElement` no longer probes. At pick time it only fires `ELEMENT_CAPTURED`, stashes the **live node** (`lastPicked = { id, el }`), and stores a fallback `selector` (`cssPath`) on the component. The sweep runs later, when the user clicks **"Reconstruct with AI"** — the side panel sends `REPROBE { captureId, selector, rect }` to the page, content.js re-locates the element via `locatePicked()` (live ref → `querySelector(selector)` → `elementFromPoint(rect center)`), runs `runInteractionProbe(el, captureId)`, and returns the states through `sendResponse`. If the element can't be found (page navigated / re-rendered), it returns `{ ok:false }` and reconstruction proceeds with the resting capture only.

Why deferred: captures you never reconstruct cost zero probing, picks are instant, and the live page is available so the sweep (and future AI-directed exploration) can run on the real DOM.

**This uses NO AI** (the sweep itself is deterministic) — the LLM is only invoked during reconstruction. The heuristic sweep:

1. **Candidates:** `findCandidates()` collects up to `PROBE_MAX`(16) interactive parts (root + buttons/links/`[aria-*]`/`[data-tooltip]`/`[tabindex]`/`cursor:pointer`/`[data-interaction]`), scored so the root + likely-interactive elements come first.
2. **Top-level pass:** every candidate is hovered via `probeAction()`. `performAction()` applies the action — `applyForcedHover()` injects matching `:hover`/`:focus` rules scoped under `.__as_force_state__` on `<html>` (synthetic events can't trigger native `:hover`); `click` (used only in nesting) is wrapped with a capture-phase `preventDefault` so handlers run without navigating. A `MutationObserver` on `document.body` records added nodes (incl. portaled popovers) + attr flips; `probeUnionRect()` is screenshotted via `CAPTURE_VISIBLE` (background, throttled) and cropped in-page. State resets between actions.
3. **Reveal detection (DOM + pixels):** a state is kept if the DOM changed (added nodes via `anyVisible` — counts a node if it OR any descendant is visible, so portaled/fading wrappers register) **OR** `diffRect()` finds changed pixels anywhere in the viewport (comparing the full before/after screenshots). The pixel path is what catches popovers rendered **outside the picked element**, portaled hovercards, and shadow-DOM content the `MutationObserver` can't attribute. The capture crop is `unionRects(domRect, changedRect)` so an off-element popover is always inside the screenshot. The cursor is hidden during capture (`captureHidingCursor()`) so it never pollutes the diff. The observer watches `document.documentElement` (not just `body`) to catch html-level portals.
   - **Settle wait:** after each action, `waitForSettle()` waits `PROBE_SETTLE_MS`(500) minimum, then until the DOM stops mutating for `PROBE_QUIET_MS`(850), capped at `PROBE_MAX_WAIT_MS`(6000) — so slow/async reveals (fetched menus, delayed tooltips) are fully captured before the screenshot.
4. **Nested pass (heuristic, one level):** for up to `NESTED_PARENTS`(2) parents that revealed new UI, re-open the parent and probe up to `NESTED_CHILDREN`(3) newly-revealed interactive elements via `probeChildOpen()` (parent kept open) — e.g. a submenu inside an opened menu.

Total states are capped at `MAX_STATES`(12).

Side panel ⇄ Content (request/response):
- `REPROBE { captureId, selector, rect }` → `{ ok, states: [...] }` — full heuristic sweep of the picked element.
- `REPROBE_TARGETS { captureId, selector, rect, targets:[{ selector, action }] }` → `{ ok, states: [...] }` — targeted re-probe of specific triggers the agent flagged.

State shape: `{ trigger, action, addedNodes, attrChanges, screenshot }`; failures return `{ ok:false, reason }`.

The LLM is used **only** at reconstruct time: `reconstructComponent(component, screenshot, apiKey, provider, interactions)` feeds the resting screenshot + every captured interaction screenshot + an "Observed interaction states" spec (treated as ground truth) into a generation call.

### Agentic reconstruction loop (the AI agent — runs ONLY on "Reconstruct with AI")

"Reconstruct with AI" is not a one-shot call. `agenticReconstruct()` runs a self-correcting **generate → render → critique → (re-probe) → revise** loop so the model sees and fixes its own output:

1. **Generate** — `reconstructComponent()` produces the initial HTML.
2. **Render** — `renderHtmlToImage()` mounts the generated HTML in an isolated offscreen `<iframe srcdoc>` (inside `#render-harness`) and rasterizes it to a PNG with **html2canvas**. Inline `<script>` does NOT run (extension CSP), so this captures the **resting visual state**. Returns `null` (and the loop gracefully stops) if rasterization fails (e.g. tainted cross-origin images).
3. **Critique** — `critiqueReconstruction()` sends two images to the LLM (IMAGE 1 = original capture, IMAGE 2 = the render) plus the component HTML and the list of already-captured interaction triggers. Returns JSON `{ verdict, score, issues, missingInteractions }`. Part A judges resting-state fidelity only (ignores JS-only reveals — avoids false negatives); Part B flags interactive affordances visible in the original whose behavior hasn't been captured yet (`missingInteractions: [{ selector, action, why }]`).
4. **Verification-driven re-probe** — if the critique flagged `missingInteractions`, `reprobeTargets()` sends `REPROBE_TARGETS { captureId, selector, rect, targets }` to the page; content.js `probeTargets()` exercises those exact selectors/actions on the **live original** and returns fresh states, which are merged (de-duped by trigger, `mergeInteractionStates`) into the interaction set. A `requestedSelectors` guard prevents re-probing the same trigger across iterations.
5. **Revise** — `reviseReconstruction()` feeds the current HTML + the issue list + both images + the (now augmented) interaction set back to the model for a corrected full HTML, then loops.

**Best-of-N (no regressions):** every critiqued candidate is scored, and `agenticReconstruct` returns the **highest-scoring** HTML — never blindly the last revision. So a revise pass that makes things worse can't degrade the final result below the initial generation. The revise prompt is also explicitly a *targeted fix* ("preserve everything that already matches — tooltips/dropdowns/states from the original HTML/CSS; change only what fixes the listed issues"), and the critique will **not** flag interactions already present in the HTML (e.g. `title`/`aria` tooltips, in-DOM menus, CSS `:hover`) so it stops needlessly re-probing/rewriting things the one-shot already got right.

**Effort toggle** (`#recon-effort`, persisted as `reconEffort`): Low/Medium/High → `EFFORT_TRIES` = **1 / 3 / 5** passes (`maxIters`). The loop **closes early** when it's good enough — resting `pass` (score ≥ 85, no issues) **and** no missing interactions. It also stops when render/rasterize fails or the pass budget runs out. At Low (1 pass) there's no revise/re-probe — just generate + one critique, so the output equals the classic one-shot reconstruction. Each phase streams to the `#verify-progress` panel via `onProgress`. If there's no reference screenshot, verification is skipped and the first generation is returned.

> Resting fidelity is verified by actually rendering the output. Interactions are NOT rendered (iframe can't run their JS) — instead the agent improves them by **re-probing the live original** for affordances the critique says are missing, then feeding richer ground truth into the next revision. `agenticReconstruct` returns the final (augmented) interaction set, which is what gets saved.

On "Reconstruct with AI", the side panel first runs the deferred `REPROBE` sweep, stores the returned states in `pendingInteractions`, shows thumbnails in the preview panel, then feeds them into `reconstructComponent(..., interactions)` — multiple labeled images + a text "Observed interaction states" spec marked as ground truth. Specs (minus images) persist on the saved component as `comp.interactions`. (Saving raw HTML/CSS without reconstructing therefore stores no interaction specs, since the sweep hasn't run.)

Background → All captures (baseline + probe) go through `queuedCapture()` which serializes `captureVisibleTab` calls ≥700ms apart (it is rate-limited to ~2/sec).

---

## Claude API usage

Three calls, all using `claude-opus-4-6`, max 4096 tokens:

1. **reconstructComponent(comp, screenshotDataUrl, apiKey)** + the verification loop
   - Input: outerHTML + filtered CSS (resolved vars) + screenshot + font list
   - Output: single self-contained `.html` file (no markdown, no explanation)
   - Goal: replicate look + infer/implement interactions in vanilla JS
   - Wrapped by `agenticReconstruct()`, which adds up to 3 extra LLM calls: `critiqueReconstruction()` (vision compare → JSON verdict) and `reviseReconstruction()` (fix the listed issues). See "Agentic reconstruction loop" above.

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
