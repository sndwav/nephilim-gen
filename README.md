# Nephilim Gen — Game Asset Image Generator

A small, local web app for generating game art (icons, portraits, backgrounds, and more) with
Google's Gemini image models. You combine a reusable **prompt template** with a short **subject**
you type, plus a set of **reference images** for style, and get a generated image back.

Everything runs **on your own machine** — the app is never hosted, your API key stays on the
server side, and your presets and images are stored as plain files you can back up by copying a folder.

```
Pick a preset (e.g. "Icon")
   └─ pick a sub-preset (e.g. "Ability Icon")
        └─ type a subject (e.g. "three enemy silhouettes in glowing chains")
             └─ the subject is injected into the template + reference images are attached
                  └─ Gemini returns the image, shown in the right pane
```

---

## Features

- **Presets & sub-presets** — organize prompt templates by category and asset type.
- **Live prompt preview** — see exactly what will be sent as you type (`{{subject}}` is replaced in place).
- **Reference images** — upload style references per sub-preset; they're sent with the prompt.
- **Per-sub-preset settings** — model, aspect ratio, and resolution.
- **Full editor** — create/rename/delete presets and sub-presets in the UI.
- **Download + auto-save** — every generation is saved to `data/outputs/` automatically.
- **Activity log** — a scrollable log of what was generated and where it was saved.
- Keyboard shortcut: **Ctrl+Enter** to generate.

---

## Requirements

- **Node.js 20 or newer** (LTS recommended).
- A **Google Gemini API key**.
- Optionally **Git**, if you want to clone the repo (you can also download it as a ZIP).

> ⚠️ **Cost note:** image generation is a **paid / metered** feature on most Gemini tiers. Check current
> pricing at <https://ai.google.dev/gemini-api/docs/pricing> before generating in bulk — don't assume a free tier.

---

## Setup from scratch

If nothing is installed yet, follow these steps in order.

### 1. Install Node.js

Download the **LTS** version (v20+) from <https://nodejs.org> and install it with the default options.
Then confirm it worked — open a terminal (Windows: **PowerShell**; macOS: **Terminal**) and run:

```bash
node --version
```

You should see something like `v20.x.x` or higher. (`npm` is installed automatically with Node.)

### 2. Get the code

**Option A — clone with Git** (install Git from <https://git-scm.com> first):

```bash
git clone https://github.com/sndwav/nephilim-gen.git
cd nephilim-gen
```

**Option B — download the ZIP** (no Git needed):
On the GitHub page, click **Code ▸ Download ZIP**, unzip it, and open a terminal in the unzipped folder.

> **Opening a terminal in the folder (Windows):** open the folder in File Explorer, type `powershell`
> in the address bar, and press Enter. **(macOS):** right-click the folder ▸ *New Terminal at Folder*.

### 3. Get a Gemini API key

Go to <https://aistudio.google.com/apikey>, sign in, create a key, and copy it.

### 4. Create your `.env` file

The app reads your key from a file named `.env` in the project folder. Copy the example and edit it:

```bash
# Windows (PowerShell)
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```

Open `.env` in any text editor and replace the placeholder with your real key:

```
GEMINI_API_KEY=paste-your-key-here
```

No quotes, no spaces around the `=`. **Your key never leaves your machine** and is never sent to the browser.

### 5. Install dependencies

Run this once (it creates a `node_modules` folder and may take a minute):

```bash
npm install
```

### 6. Start the app

```bash
npm start
```

You'll see:

```
Nephilim Generator -> http://localhost:5173
```

Open **<http://localhost:5173>** in your browser.

- **To stop:** press **Ctrl+C** in the terminal.
- **To run again later:** open a terminal in the folder and run `npm start` (no need to reinstall).

---

## Using the app

1. Pick a **preset** and **sub-preset** from the dropdowns on the left (a seeded **Icon → Ability Icon**
   example is included on first run).
2. Type a **subject**. The read-only **prompt preview** updates live.
3. Click **Generate** (or press **Ctrl+Enter**). The image appears on the right; a copy is auto-saved to `data/outputs/`.
4. Use **Download** to save it anywhere, or **Copy prompt** to copy the exact prompt used.

**Editing presets & references:** click **Edit** (or **+ New**) to open the editor. There you can rename
presets, add/edit/delete sub-presets (prompt template, model, aspect ratio, resolution), and manage
**reference images** (upload, view thumbnails, remove). Reference images define the style sent to the model.

**Prompt templates** must contain the token `{{subject}}` where your typed subject should be inserted.
If a template has no `{{subject}}`, the subject is appended at the end (the editor warns you).

**Models available per sub-preset:**

| Model | Name | Use for |
|---|---|---|
| `gemini-3.1-flash-image` | Nano Banana 2 | **Default.** Fast, up to 14 reference images, 512/1K/2K/4K. |
| `gemini-3-pro-image` | Nano Banana Pro | Highest quality & best text rendering; slower/pricier. |
| `gemini-2.5-flash-image` | Nano Banana (legacy) | Cheaper fallback, 1K only. |

---

## Where your data lives

Everything you create is stored as plain files under `data/` (created automatically on first run):

```
data/
├─ presets.json                    # all presets & sub-presets
├─ references/<subPresetId>/...     # your uploaded reference images
└─ outputs/                         # every generated image, auto-saved
```

This is **durable** (survives clearing your browser), **portable** (back it up or move it by copying the
folder), and **inspectable** (open the JSON and images directly). The `data/` folder is **not** tracked by
Git, so your library and generated images stay private and local — **to move the app to another machine,
copy the `data/` folder (and your `.env`) across.**

---

## Updating to the latest version

If you cloned with Git:

```bash
git pull
npm install   # in case dependencies changed
npm start
```

---

## Troubleshooting

- **`GEMINI_API_KEY is not set`** — the `.env` file is missing, misspelled, or in the wrong folder.
  Fix it and restart the server (`Ctrl+C`, then `npm start`). Changes to `.env` only take effect on restart.
- **`API key not valid` / 400 / 403** — the key is wrong or lacks image access; create a fresh key at
  <https://aistudio.google.com/apikey>.
- **`address already in use` / port 5173 busy** — change `const PORT = 5173;` near the top of `server.js`
  to e.g. `5174`, then open that port instead.
- **`command not found: npm`** — Node didn't install correctly; reinstall from step 1 and reopen the terminal.
- **Generation takes 30–60s** — normal for Nano Banana Pro or 4K sizes. Wait for the spinner.
- **No image returned (only a message)** — usually a safety block; the returned text is shown as the
  explanation. Adjust the prompt or references.

---

## How it works (tech notes)

- **Front end:** a single `public/index.html` — HTML + CSS + vanilla JavaScript. No framework, no build step.
- **Server:** `server.js` — a small [Express](https://expressjs.com/) server using the official
  [`@google/genai`](https://www.npmjs.com/package/@google/genai) SDK.
- **Why a server?** Browsers can't call the Gemini API directly (CORS), and the API key must stay off the
  client. The server makes the Gemini calls and serves the page from the same origin.

```
nephilim-gen/
├─ server.js            # Express server + Gemini integration
├─ public/index.html    # the entire front end
├─ package.json
├─ .env.example         # copy to .env and add your key
└─ data/                # created on first run (git-ignored)
```

> **Local single-user use only** — do not expose this server to your network or the internet.
