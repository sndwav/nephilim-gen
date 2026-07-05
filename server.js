import "dotenv/config";
import express from "express";
import { GoogleGenAI } from "@google/genai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5173;
const DATA_DIR = path.join(__dirname, "data");
const REFS_DIR = path.join(DATA_DIR, "references");
const OUTPUTS_DIR = path.join(DATA_DIR, "outputs");
const FRAMES_DIR = path.join(DATA_DIR, "frames");
const EXPORTS_DIR = path.join(DATA_DIR, "exports");
const PRESETS_FILE = path.join(DATA_DIR, "presets.json");
const TEXT_STORE_FILE = path.join(DATA_DIR, "text-editor.json");
const TEXT_MODEL = "gemini-2.5-flash";   // text model for the DOS2 formatter (see POST /api/text/format)

const SEED = {
  presets: [{
    id: "preset-icon",
    name: "Icon",
    subPresets: [{
      id: "sub-ability-icon",
      name: "Ability Icon",
      promptTemplate:
        "Following the style of the provided icons, generate a single large canvas containing 16 different new icons.\n" +
        "Format: 16 square icons (4 by 4 grid) (1:1 ratio), without frames.\n" +
        "Subject: {{subject}}.\n" +
        "Effects and color: auto, green, red.\n" +
        "Background: in the style of the provided icons.",
      referenceImages: [],
      model: "gemini-3.1-flash-image",
      aspectRatio: "1:1",
      resolution: "1K",
      exportWidth: 64,
      exportHeight: 64,
    }],
  }],
};

// The canonical Wisp ability description — the mod's house style for DOS2 <font> markup.
const WISP_EXAMPLE = "<font color='#a2bc84'>Use the power of the <font color='#ed4d00'>Nephilim</font> to release a volatile wisp of lightning. It drifts towards a nearby foe, inflicting <font color='#f2df88'>Air Damage</font> upon impact, potentially leaving the target <font color='#f2df88'>Shocked</font> or shattering their <font color='#f2df88'>Magic Armor.</font></font><br><br><font color='#e4decb'  size='16'>You remain free to perform other actions while the Wisp is in flight.</font>";

// Seed for the Text Editor store: a starter palette + presets. A preset is a category of asset
// (e.g. "Nephilim Ability") that holds a set of example descriptions; those examples guide the
// AI formatter for that category (the text analogue of the image tab's reference images).
const TEXT_SEED = {
  palette: [
    { id: "col-body", name: "Body (green)", hex: "#a2bc84" },
    { id: "col-nephilim", name: "Nephilim", hex: "#ed4d00" },
    { id: "col-keyword", name: "Keyword (yellow)", hex: "#f2df88" },
    { id: "col-note", name: "Secondary note", hex: "#e4decb" },
  ],
  presets: [
    { id: "preset-nephilim-ability", name: "Nephilim Ability", examples: [{ id: "ex-wisp", title: "Wisp (Air ability)", text: WISP_EXAMPLE }] },
    { id: "preset-status-buff", name: "Status (Buff) Description", examples: [] },
  ],
};

// ---------- storage helpers ----------
async function ensureSetup() {
  await fs.mkdir(REFS_DIR, { recursive: true });
  await fs.mkdir(OUTPUTS_DIR, { recursive: true });
  await fs.mkdir(FRAMES_DIR, { recursive: true });
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  try { await fs.access(PRESETS_FILE); }
  catch { await fs.writeFile(PRESETS_FILE, JSON.stringify(SEED, null, 2)); }
  try { await fs.access(TEXT_STORE_FILE); }
  catch { await fs.writeFile(TEXT_STORE_FILE, JSON.stringify(TEXT_SEED, null, 2)); }
}
async function readPresets() { return JSON.parse(await fs.readFile(PRESETS_FILE, "utf8")); }
async function writePresets(data) {
  const tmp = PRESETS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, PRESETS_FILE);            // atomic write
}
// Normalize/upgrade a text store to the current shape: { palette, presets:[{id,name,examples}] }.
// Transparently migrates the older { palette, examples, documents } layout so no data is lost.
function migrateTextStore(data) {
  data = data || {};
  const palette = Array.isArray(data.palette) ? data.palette : [];
  let presets = Array.isArray(data.presets) ? data.presets : null;
  if (!presets) {
    presets = [];
    const legacyExamples = Array.isArray(data.examples) ? data.examples : [];
    presets.push({ id: "preset-nephilim-ability", name: "Nephilim Ability", examples: legacyExamples });
    const docs = Array.isArray(data.documents) ? data.documents : [];
    if (docs.length) presets.push({
      id: "preset-saved",
      name: "Saved descriptions",
      examples: docs.map((d) => ({ id: d.id || crypto.randomUUID(), title: d.name || "Untitled", text: d.source || "" })),
    });
  }
  presets = presets.map((p) => ({
    id: p.id || crypto.randomUUID(),
    name: p.name || "Untitled",
    examples: (Array.isArray(p.examples) ? p.examples : []).map((e) => ({
      id: e.id || crypto.randomUUID(), title: e.title || "", text: e.text || "",
    })),
  }));
  return { palette, presets };
}
async function readTextStore() { return migrateTextStore(JSON.parse(await fs.readFile(TEXT_STORE_FILE, "utf8"))); }
async function writeTextStore(data) {
  const tmp = TEXT_STORE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, TEXT_STORE_FILE);         // atomic write
}
function findSubPreset(data, subId) {
  for (const p of data.presets) {
    const s = p.subPresets.find((x) => x.id === subId);
    if (s) return s;
  }
  return null;
}
function injectSubject(template, subject) {
  const s = subject.trim();
  return template.includes("{{subject}}")
    ? template.replaceAll("{{subject}}", s)
    : `${template.trim()}\nSubject: ${s}.`;
}

// ---------- Gemini client (lazy so a missing key doesn't crash startup) ----------
let _ai;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _ai;
}

const app = express();
app.use(express.json({ limit: "50mb" }));       // base64 reference uploads can be large

// ---------- presets CRUD ----------
app.get("/api/presets", async (_req, res) => {
  res.json(await readPresets());
});
app.post("/api/presets", async (req, res) => {
  const data = await readPresets();
  const preset = { id: crypto.randomUUID(), name: req.body.name || "New Preset", subPresets: [] };
  data.presets.push(preset);
  await writePresets(data);
  res.json(preset);
});
app.put("/api/presets/:id", async (req, res) => {
  const data = await readPresets();
  const i = data.presets.findIndex((p) => p.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Preset not found." });
  // Preserve reference images (managed by /api/references), keyed by sub-preset id.
  const refsById = {};
  for (const s of data.presets[i].subPresets) refsById[s.id] = s.referenceImages || [];
  data.presets[i] = {
    ...req.body,
    id: req.params.id,
    subPresets: (req.body.subPresets || []).map((s) => ({
      ...s,
      id: s.id || crypto.randomUUID(),
      referenceImages: refsById[s.id] || [],
    })),
  };
  await writePresets(data);
  res.json(data.presets[i]);
});
app.delete("/api/presets/:id", async (req, res) => {
  const data = await readPresets();
  const preset = data.presets.find((p) => p.id === req.params.id);
  data.presets = data.presets.filter((p) => p.id !== req.params.id);
  await writePresets(data);
  if (preset) for (const s of preset.subPresets) {
    await fs.rm(path.join(REFS_DIR, s.id), { recursive: true, force: true });
  }
  res.json({ ok: true });
});

// ---------- reference images ----------
// body: { subPresetId, name, mimeType, dataBase64 }  (base64 without the data: prefix)
app.post("/api/references", async (req, res) => {
  const { subPresetId, name, mimeType, dataBase64 } = req.body;
  const data = await readPresets();
  const sub = findSubPreset(data, subPresetId);
  if (!sub) return res.status(404).json({ error: "Sub-preset not found." });

  const id = crypto.randomUUID();
  const ext = (mimeType && mimeType.split("/")[1]) || "png";
  const filename = `${id}.${ext}`;
  const dir = path.join(REFS_DIR, subPresetId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), Buffer.from(dataBase64, "base64"));

  const ref = { id, filename, originalName: name || filename, mimeType: mimeType || "image/png" };
  sub.referenceImages = sub.referenceImages || [];
  sub.referenceImages.push(ref);
  await writePresets(data);
  res.json(ref);                                  // thumbnail URL: /references/<subPresetId>/<filename>
});
app.delete("/api/references/:subPresetId/:refId", async (req, res) => {
  const { subPresetId, refId } = req.params;
  const data = await readPresets();
  const sub = findSubPreset(data, subPresetId);
  if (!sub) return res.status(404).json({ error: "Sub-preset not found." });
  const ref = (sub.referenceImages || []).find((r) => r.id === refId);
  if (ref) {
    await fs.rm(path.join(REFS_DIR, subPresetId, ref.filename), { force: true });
    sub.referenceImages = sub.referenceImages.filter((r) => r.id !== refId);
    await writePresets(data);
  }
  res.json({ ok: true });
});

// ---------- generation ----------
// body: { subPresetId, subject }
app.post("/api/generate", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not set. Add it to .env and restart the server." });
    }
    const { subPresetId, subject } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: "Subject is required." });

    const data = await readPresets();
    const sub = findSubPreset(data, subPresetId);
    if (!sub) return res.status(404).json({ error: "Sub-preset not found." });

    const prompt = injectSubject(sub.promptTemplate, subject);

    const parts = [{ text: prompt }];
    for (const ref of sub.referenceImages || []) {
      const buf = await fs.readFile(path.join(REFS_DIR, subPresetId, ref.filename));
      parts.push({ inlineData: { mimeType: ref.mimeType, data: buf.toString("base64") } });
    }

    const response = await getAI().models.generateContent({
      model: sub.model,
      contents: [{ parts }],
      config: {
        responseModalities: ["IMAGE", "TEXT"],
        imageConfig: { aspectRatio: sub.aspectRatio, imageSize: sub.resolution },
      },
    });

    const outParts = response?.candidates?.[0]?.content?.parts ?? [];
    const imgPart = outParts.filter((p) => p.inlineData && !p.thought).pop();   // skip thought images
    if (!imgPart?.inlineData?.data) {
      const text = outParts.filter((p) => p.text).map((p) => p.text).join(" ").trim();
      return res.status(502).json({ error: text || "The model returned no image. Adjust the prompt or references." });
    }
    const mime = imgPart.inlineData.mimeType || "image/png";
    const b64 = imgPart.inlineData.data;

    // auto-save a copy (Optional but recommended)
    const outName = `${Date.now()}-${sub.name.replace(/\W+/g, "_")}.${mime.split("/")[1] || "png"}`;
    await fs.writeFile(path.join(OUTPUTS_DIR, outName), Buffer.from(b64, "base64"));

    res.json({ imageDataUrl: `data:${mime};base64,${b64}`, promptUsed: prompt, model: sub.model, savedAs: outName });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Image generation failed." });
  }
});

// ---------- frames (global overlay PNGs) ----------
// body: { name, mimeType, dataBase64 }  — PNG only (transparency required)
app.post("/api/frames", async (req, res) => {
  const { name, mimeType, dataBase64 } = req.body;
  if (!dataBase64) return res.status(400).json({ error: "Missing image data." });
  if (mimeType && mimeType !== "image/png")
    return res.status(400).json({ error: "Frames must be PNG (transparency required)." });
  const data = await readPresets();
  const id = crypto.randomUUID();
  const filename = `${id}.png`;
  await fs.mkdir(FRAMES_DIR, { recursive: true });
  await fs.writeFile(path.join(FRAMES_DIR, filename), Buffer.from(dataBase64, "base64"));
  const frame = { id, filename, originalName: name || filename };
  data.frames = data.frames || [];
  data.frames.push(frame);
  await writePresets(data);
  res.json(frame);                                // thumbnail URL: /frames/<filename>
});
app.delete("/api/frames/:id", async (req, res) => {
  const data = await readPresets();
  const frame = (data.frames || []).find((f) => f.id === req.params.id);
  if (frame) {
    await fs.rm(path.join(FRAMES_DIR, frame.filename), { force: true });
    data.frames = data.frames.filter((f) => f.id !== req.params.id);
    await writePresets(data);
  }
  res.json({ ok: true });
});

// ---------- export (save the composed PNG to disk) ----------
// body: { name, dataBase64 }  (composed PNG, base64 without the data: prefix)
app.post("/api/export", async (req, res) => {
  try {
    const { name, dataBase64 } = req.body;
    if (!dataBase64) return res.status(400).json({ error: "Missing image data." });
    const outName = `${Date.now()}-${(name || "export").replace(/\W+/g, "_")}.png`;
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
    await fs.writeFile(path.join(EXPORTS_DIR, outName), Buffer.from(dataBase64, "base64"));
    res.json({ savedAs: outName });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Export save failed." });
  }
});

// ---------- text editor: palette + presets store ----------
app.get("/api/text", async (_req, res) => {
  res.json(await readTextStore());
});
// Whole-store replace (client mutates in memory, then persists the lot) — mirrors the presets PUT.
app.put("/api/text", async (req, res) => {
  const data = migrateTextStore(req.body || {});   // normalizes shape + fills missing ids
  await writeTextStore(data);
  res.json(data);
});

// ---------- text editor: AI formatter (DOS2 <font> markup) ----------
function stripCodeFences(s) {
  return String(s || "")
    .trim()
    .replace(/^```[a-zA-Z]*\s*\n?/, "")   // opening ``` or ```html
    .replace(/\n?```$/, "")               // closing ```
    .replace(/^Output:\s*/i, "")          // a stray echoed "Output:" label
    .trim();
}
function buildFormatSystemPrompt(palette) {
  const colorLines = (palette || []).map((c) => `  - ${c.name}: ${c.hex}`).join("\n") || "  (none defined)";
  return [
    'You format in-game ability/item descriptions for a Divinity: Original Sin 2 mod ("Souls of the Nephilim").',
    "",
    "OUTPUT MARKUP RULES:",
    "- The ONLY tags allowed are <font> and <br>. No other HTML.",
    "- A styled run is: <font color='#hex' size='N'>text</font>. color is a 6-digit hex; size is an OPTIONAL integer pixel size.",
    "- Use SINGLE quotes around attribute values.",
    "- FLAT output only — NEVER nest a <font> inside another <font>. Each styled run is its own self-contained <font>...</font>.",
    "- Use <br> for line breaks. Ordinary body text may be left untagged.",
    "- Output ONLY the formatted string: no markdown, no code fences, no commentary, no 'Output:' prefix.",
    "",
    "COLOR PALETTE (name: hex):",
    colorLines,
    "",
    "SEMANTIC COLORING GUIDE:",
    "- Body / ordinary sentences: the body green.",
    '- Proper nouns and mod-specific names (e.g. "Nephilim"): the Nephilim orange.',
    '- Damage types, status effects and keywords (e.g. "Air Damage", "Shocked", "Magic Armor"): the keyword yellow.',
    "- Secondary / aside notes (e.g. a line about acting freely): the cream note color, usually at size='16', after a <br><br>.",
    "",
    "WRITING TASK:",
    "- The user gives a rough, terse description of what an ability or effect does. REWRITE it into a polished description that reads like the examples.",
    "- Rephrase freely: match the examples' voice, tone, sentence structure, cadence and vocabulary. Do NOT merely reuse the user's wording or just wrap it in tags.",
    "- Keep the mechanics accurate: damage types, status effects, numbers, targets and conditions must be preserved.",
    "- Then apply the markup and semantic coloring rules above.",
    "",
    'For example, given "a lightning bolt that deals air damage and has a chance to stun the enemy" with the Nephilim ability style, a good result reads like: "Use the power of the Nephilim to unleash a striking lightning bolt that inflicts Air Damage upon impact and potentially Stuns the enemy." — then colored per the palette.',
  ].join("\n");
}
function buildFormatUserPrompt(text, instructions, examples) {
  const shots = (examples || []).filter((e) => e && e.text).map((e) => e.text);
  let prompt = "";
  if (shots.length) {
    prompt += "Example descriptions written in the target style (match their voice, phrasing, structure and coloring):\n\n";
    prompt += shots.map((t, i) => `Example ${i + 1}:\n${t}`).join("\n\n");
    prompt += "\n\n---\n\n";
  }
  prompt += "Rewrite the following rough description into a new description in that same style. Rephrase freely to match the examples; keep the mechanics (damage types, effects, numbers, targets) accurate.";
  if (instructions && instructions.trim()) prompt += ` Additional instructions: ${instructions.trim()}`;
  prompt += `\n\nRough description:\n${String(text).trim()}\n\nFormatted description:`;
  return prompt;
}
app.post("/api/text/format", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not set. Add it to .env and restart the server." });
    }
    const { text, instructions, presetId } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "Text is required." });

    const store = await readTextStore();
    const preset = (store.presets || []).find((p) => p.id === presetId) || store.presets[0] || null;
    const examples = preset ? preset.examples : [];
    const response = await getAI().models.generateContent({
      model: TEXT_MODEL,
      contents: [{ parts: [{ text: buildFormatUserPrompt(text, instructions, examples) }] }],
      config: { systemInstruction: buildFormatSystemPrompt(store.palette), temperature: 0.7 },
    });

    let out = (response.text || "").trim();
    if (!out) {                                    // fallback: pull text parts directly (skip thoughts)
      const parts = response?.candidates?.[0]?.content?.parts ?? [];
      out = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
    }
    out = stripCodeFences(out);
    if (!out) return res.status(502).json({ error: "The model returned no text. Try again or adjust the input." });
    res.json({ result: out });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Formatting failed." });
  }
});

// ---------- static files ----------
app.use("/references", express.static(REFS_DIR));
app.use("/frames", express.static(FRAMES_DIR));
app.use(express.static(path.join(__dirname, "public")));

await ensureSetup();
app.listen(PORT, () => console.log(`\n  Nephilim Generator -> http://localhost:${PORT}\n`));
