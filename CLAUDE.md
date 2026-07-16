# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, single-user web app for making assets for the **Souls of the Nephilim** mod (Divinity: Original Sin 2), powered by Google Gemini. Three tabs: an **Icon Generator** (preset-driven: prompt templates + per-preset *style* reference images, plus optional per-generation *subject* reference images → game art), an **Image Generator** (preset-less / "classic": a free-text prompt + optional inline reference images → one image), and a **Text Editor** (WYSIWYG for DOS2 `<font color size>` markup with an AI formatter). Local-only use is a **convention, not a code guarantee** — `app.listen(PORT)` binds all interfaces and there is no auth or input validation, so nothing here should ever be exposed to a network.

## Commands

```bash
npm install        # once
npm start          # runs node server.js → http://localhost:5173
```

- No build step, no tests, no linter. The frontend is served statically; edit → refresh browser. Server changes need a restart.
- All three dependencies (`express`, `@google/genai`, `dotenv`) are declared as `"latest"` in `package.json` — **the committed `package-lock.json` is the only version pin** (currently Express 5.x, `@google/genai` 2.x). Regenerating the lockfile silently jumps to whatever is newest; check installed versions before reasoning about framework behavior.
- Requires Node 20+ and a `.env` with `GEMINI_API_KEY` (copy `.env.example`). The key is read at request time, so the server starts fine without it; only the two AI endpoints 500.
- `PORT = 5173` is hardcoded near the top of `server.js` (no env override).
- Windows users double-click `Start Nephilim Generator.bat` (installs deps, opens browser) and `Update Nephilim Generator.bat` (`git pull --ff-only` + `npm install`). Keep these in sync if startup behavior changes.

## Architecture

The entire app is **two source files**:

- **`server.js`** (~440 lines) — Express server, ESM (`type: module`, top-level `await` before `listen`). All API routes, Gemini calls (via `@google/genai`), and disk persistence.
- **`public/index.html`** (~2400 lines) — the entire frontend: one `<style>` block, the HTML (three tab panels + all modals), one `<script>` block of vanilla JS. No framework, no build, no external assets (Lucide icons are inlined SVG paths in the `ICONS` map).

The server exists because the browser can't call Gemini directly (CORS + key secrecy). All user data lives under `data/` (git-ignored, created/seeded on first run):

```
data/presets.json        # image presets/sub-presets + global frames metadata
data/text-editor.json    # text-editor palette + presets (AI example sets)
data/references/<subId>/ # uploaded reference images (served at /references/...)
data/frames/             # overlay PNGs (served at /frames/...)
data/outputs/            # every generated image, auto-saved (disk archive only, no route)
data/exports/            # composed PNGs from "Prepare for export" (disk archive only)
```

### Server (`server.js`)

Top-of-file: path constants, `TEXT_MODEL` (`gemini-2.5-flash`), `SEED` / `TEXT_SEED` (first-run data), then helpers, then routes in groups:

| Group | Routes |
|---|---|
| Image presets CRUD | `GET/POST /api/presets`, `PUT/DELETE /api/presets/:id` |
| Reference images | `POST /api/references`, `DELETE /api/references/:subPresetId/:refId` |
| Generation | `POST /api/generate` `{subPresetId, subject, subjectReferences[]}` → `{imageDataUrl, promptUsed, model, savedAs}` |
| Freeform generation | `POST /api/generate-classic` `{prompt, model, aspectRatio, resolution, references[]}` → same shape as `/api/generate` (no preset; prompt verbatim, inline refs, no disk) |
| Frames (global overlays) | `POST /api/frames` (PNG only), `DELETE /api/frames/:id` |
| Export | `POST /api/export` (saves a client-composed PNG to `data/exports/`) |
| Text store | `GET/PUT /api/text` (whole-store replace) |
| AI formatter | `POST /api/text/format` `{text, presetId, skill?}` → `{result, names[]}` |

Key mechanics:

- **Persistence pattern**: whole-document replace. Clients PUT the entire preset/store; there is no PATCH. JSON stores are written atomically (tmp file + rename) via `writePresets`/`writeTextStore` — never `fs.writeFile` a store directly (first-run seeding in `ensureSetup` is the one existing exception). There is **no locking**: concurrent read-modify-writes are last-writer-wins.
- **Two kinds of reference image (icon tab)**: the sub-preset's `referenceImages` are **style** references (what it should *look like*; on disk, persisted). `POST /api/generate`'s `subjectReferences[]` are per-generation **subject** references (what should be *depicted*) — inline base64 in the body like `/api/generate-classic`, never written to disk or into a preset. Gemini gets one flat parts list, so the roles are distinguished by `STYLE_REF_LABEL` / `SUBJECT_REF_LABEL` text parts introducing each group. Those labels are emitted **only when subject references are present**, so a style-only call is exactly what it always was — keep that conditional if you touch the assembly. Order matters: prompt → style label → style images → subject label → subject images.
- **Image call**: prompt text part + one `inlineData` part per reference image; `responseModalities: ["IMAGE","TEXT"]`, `imageConfig: {aspectRatio, imageSize}`. Response parsing skips `p.thought` image parts and takes the **last** image part; if none, the model's text parts become the 502 error message (that text fallback does *not* filter thoughts — asymmetric with the text formatter, which does). Result is auto-saved to `data/outputs/` and returned as a base64 data URL (generated images are never served by URL).
- **Text call**: `TEXT_MODEL` with a system prompt built from the palette, few-shot examples from the chosen text preset (silently falls back to `presets[0]` if `presetId` isn't found), `temperature: 0.7`, and a JSON `responseSchema` (`{description, names[]}`, uppercase genai type names). Output is defensively stripped of code fences; on JSON parse failure the raw text becomes the description.
- **`migrateTextStore`** runs on every read AND every PUT. It does two jobs: upgrades the legacy `{palette, examples, documents}` layout to `{palette, presets}` (don't "simplify" it away — old installs depend on it), and rebuilds presets/examples field-by-field, **stripping unknown top-level keys and unknown preset/example fields**. Palette entries pass through verbatim. So new fields on presets/examples/top-level require extending it; new fields on palette colors don't.
- **Seeding** only happens when a `data/*.json` file is missing. Changing `SEED`/`TEXT_SEED` does nothing for existing installs — real schema changes need migration code (like `migrateTextStore`).
- Deliberate errors are JSON `{error}`: 400 bad input, 404 missing preset/sub, 500 config/internal, 502 model returned nothing usable. But only `/api/generate`, `/api/export`, and `/api/text/format` have try/catch — an unexpected throw in any other handler falls through to Express 5's default error handler, which returns an **HTML** 500 (the process survives; Express 5 forwards rejected async handlers to the error middleware). The client's `api()` helper then surfaces that raw HTML in a toast. Preset and frame DELETEs are idempotent (`{ok:true}` even if missing); reference DELETE 404s if the *sub-preset* is missing.
- Uploads travel as base64 inside JSON bodies `{name, mimeType, dataBase64}` (no `data:` prefix, no multipart) — hence `express.json({limit: "50mb"})`.

### Frontend (`public/index.html`)

One script block, comment-sectioned in this order: constants → tiny helpers (`$`, `el()`, `icon()`, `clone()`, `uuid()`, `api()`, `fileToUpload()`, `toast()`) → image-tab state/render → generate flow → sub-preset editor modal → export/crop/frames dialog → **TEXT EDITOR** section → global event wiring → tabs → init.

- **State pattern (image tab)**: `presetsData` is a full client mirror of `presets.json`. Preset/sub-preset CRUD follows: `clone(preset)` → edit → `PUT /api/presets/:id` → `loadPresets()` re-fetches and re-renders everything (full innerHTML rebuilds, no incremental patching). Exceptions that update `presetsData` optimistically with **no re-fetch**: frame upload/delete and `saveFrameLayers` — don't assume every write path triggers a full re-render.
- **Subject references (icon tab)**: `subjectRefs` (module-level array, host `#subjectRefsBox`) is an in-memory twin of `cgState.references` — base64 held for the session only, never persisted anywhere (not the preset, not disk, not localStorage — quota), cleared on reload. Changing it must re-run `renderSubjectRefs()` + `updatePromptPreview()` (the stand-in subject changes the preview) + `updateGenerateState()` (an image alone can enable Generate).
- **Sub-preset editor modal** edits a deep-cloned draft; Save PUTs it, Cancel discards — **except reference images**, which persist immediately (upload first calls `ensureSaved()`, which PUTs the whole draft so the sub exists server-side). So Cancel does not undo reference changes, and uploading a reference mid-edit commits all draft edits.
- **Export dialog**: client-side canvas compositing. Crop rect is kept in natural-image pixel coordinates; `layers[0]` is the FRONT layer, so `recompose()` draws in reverse order; blend names must exist in both `BLENDS` (UI list) and `BLEND_CANVAS` (canvas op map); opacity is 0–100. The per-sub frame stack persists as `sub.frameLayers` via the generic whole-preset PUT.
- **Text editor** (lazily initialized on first tab activation via `switchTab`): a `contenteditable` div where **`data-color`/`data-size` attributes are the source of truth** (inline `style` is display-only). Invariants:
  - Line breaks are literal `"\n"` text nodes — Enter and paste are intercepted (`onEditorBeforeInput`/`onEditorPaste`) so the browser never inserts `<div>`/`<br>`. The selection model (`savedOffsets`) counts `"\n"` as exactly 1 char and would drift with real block elements.
  - `cleanupEditorFormatting` runs on every input to strip browser-injected styled `<span>`s that lack `data-*` (the post-delete "typing style" bug) — removing it reintroduces a silent render/serialize mismatch.
  - Round-tripping tags ↔ visual is **normalizing, not identity-preserving**: nested `<font>` flattens, only strict 6-digit `#rrggbb` colors survive, sizes outside 1–200 are **dropped** (not clamped — the run inherits the enclosing size or none), and runs of tab/CR/LF collapse to a single space (consecutive spaces survive; only `<br>` persists as a line break). Toggling views can rewrite hand-authored source.
  - Any programmatic content change must call `markDirty()` and clear/recompute `savedOffsets`.
  - The working document is saved **only to localStorage** (`teScratch`, debounced) — never server-side. Only palette/presets/examples go through `PUT /api/text`.
- **AI format** sends plain text (tags stripped) — existing coloring is discarded and the response wholesale replaces the editor content, with up to 5 name suggestions rendered as copy chips (each chip copies a ready-to-use colored DisplayName, `<font color='#ed4d00'>Name</font>`, not plain text).
- **Skill-row paste (DOS2 tooltip variables)**: pasting a tab-separated skill row (header line + value line) copied from the skills DB is auto-detected in `onEditorPaste` by `tryParseSkillRow` (three gates: ≥2 tabbed lines, ≥8 columns, and sentinel columns `StatsDescriptionParams` / `StatsDescription`+`DisplayName` — so ordinary prose is never swallowed). The parsed skill is held in the transient module var `loadedSkill` (memory only — never persisted, never entered into the editor DOM, lost on reload) and shown in a banner (`#teSkillBanner`) with a Clear button. `buildSkillContext` turns `StatsDescriptionParams` (semicolon-separated, 1-indexed) into a numbered/labeled/classified list: each variable is `USE` or `SKIP` (skip = a range/radius stat, or an index already consumed by `StatsDescription`, e.g. `Range: [1]`). When a skill is loaded, `runAiFormat` sends it as the `skill` field and the empty-text guard is relaxed (both client `runAiFormat` **and** server `POST /api/text/format` guards must allow empty `text` when `skill` is present). The AI weaves the literal `[N]` tokens into the Description; brackets survive the serializer untouched (`escapeText` only touches `& < >`).
- **Modals**: `hidden` attribute on `.modal-backdrop`. Escape handling is one centralized keydown listener with a **hard-coded priority chain — every new modal must be added there manually**. Backdrop-click-to-close is deliberately NOT implemented (a text-drag ending on the backdrop would fire a click). Toolbar buttons that must not steal the editor selection call `preventDefault()` on mousedown.
- **Keyboard**: Ctrl/Cmd+Enter dispatches by which tab panel is visible (icon generate / classic generate / AI format); Enter submits single-input modals.
- **Naming**: per-tab globals are deliberately prefixed/namespaced to avoid colliding across tabs — the Text Editor uses `te*` (`curTextPreset`, `renderTextPresets`, `currentPresetId`) and the classic Image Generator uses `cg*` (`cgState`, `cgLastResult`, `doGenerateClassic`, `#cg*` ids), both kept distinct from the icon tab's twins (`currentPreset`, `renderPresetSelect`, `selectedPresetId`). Follow this when adding code to any tab.
- **User feedback**: `toast()` for transient messages (single global element, overwrite-only); the timestamped activity log (`logMsg`) is an icon-tab facility for generation/export events (the classic tab has its own `cgLogMsg` twin).
- **Classic Image Generator tab** (`#panel-classic`, `cg*` namespace): the preset-less sibling of the icon tab — a free-text `#cgPrompt`, three settings dropdowns (reusing `MODELS`/`ASPECTS`/`RESOLUTIONS` via `selectFrom`/`field`), and an in-memory reference manager (`cgState.references` holds base64; thumbnails render from data URLs — **not** stored on disk or via `/api/references`). `doGenerateClassic` POSTs `/api/generate-classic` with the prompt + settings + inline refs. Preview/log/result-button helpers are `cg*` twins of the icon-tab ones (their own `#cg*` ids), so the icon tab is untouched. Prompt + settings persist to `localStorage["cgScratch"]`; reference base64 does **not** (quota). Eagerly initialized (`initClassic`, no lazy guard, since it fetches nothing). No "Prepare for export" — crop/frames are icon-only.

## Cross-file sync points (edit one → check the other)

These are duplicated or asymmetrically enforced between `server.js` and `public/index.html`:

1. **`injectSubject()` and `subjectForPrompt()`/`SUBJECT_REF_STANDIN`** are duplicated verbatim (server does real prompt building; the client copies power the live preview). Change both or the preview lies. `subjectForPrompt` is what decides that a subject reference image can stand in for typed subject text — the client's Generate gating (`updateGenerateState`) and the server's 400 guard must agree on that rule too.
2. **Model/aspect/resolution lists exist only in the client** (`MODEL_NAMES`, `MODELS`, `ASPECTS`, `RESOLUTIONS` near the top of the script). The server passes `sub.model/aspectRatio/resolution` to Gemini unvalidated — the client dropdowns are the only gate, so entries must be valid Gemini values. Adding/renaming a model also means updating the default in `SEED` (server) and `makeNewSub()` (client), plus the README model table.
3. **New-sub-preset defaults** in `makeNewSub()` mirror the server `SEED` sub-preset (model / 1:1 / 1K / 64×64 export). The classic tab's `cgState` defaults (client) and the `/api/generate-classic` fallback defaults (server) share the same model / 1:1 / 1K values — keep all four in sync if the default image model changes.
4. **Frames must be PNG** — enforced client-side (`handleFrameUpload`); the server-side check in `POST /api/frames` is best-effort only (it's skipped entirely when `mimeType` is omitted), so don't rely on the server to reject non-PNGs.
5. **`PUT /api/presets/:id` deliberately discards client-sent `referenceImages`** and re-attaches the server's copies keyed by sub-preset id. References are only mutable via `/api/references`. Don't "simplify" this merge; also note the PUT spreads unknown sub fields (that's how `frameLayers` survives) — a rebuild that doesn't spread would drop them.
6. **Frames metadata lives inside `presets.json`** (top-level `frames` array) even though frames are global — anything rewriting that file wholesale must preserve the key.
7. **Skill-format is split across both files**: the client parses/classifies the skill row (`tryParseSkillRow`/`buildSkillContext` in `index.html`) and computes each variable's USE/SKIP flag; the server only *renders* that structured object into the prompt (`buildSkillBlock`/`buildFormatUserPrompt` in `server.js`) and adds the `PLACEHOLDER VARIABLES` rules to `buildFormatSystemPrompt`. The classification logic lives only on the client — the server trusts the flags. The DisplayName color `#ed4d00` is hardcoded in three client spots (name-chip markup wrap, the `.chip-name` CSS, and the palette Nephilim seed) and deliberately **not** produced by the model.

## Other traps

- Deleting a frame does not clean up `frameLayers` entries referencing it — the client filters dangling `frameId`s defensively when opening the export modal. Removing a sub-preset via PUT leaves its `data/references/<subId>/` directory orphaned on disk.
- `lastResult` (the generated image) is memory-only; Download/export die on page refresh even though a copy is in `data/outputs/`.
- `POST /api/text/format` accepts an optional `instructions` field the client never sends — dormant capability, not dead code.
- The examples modal has no cancel path — Done/✕/Escape all commit.
- `WISP_EXAMPLE` (seed) uses nested `<font>` tags while the formatter system prompt forbids nesting — intentional (canonical in-game data vs. desired flat model output); don't "fix" either to match the other.
