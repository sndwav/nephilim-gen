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
      resolution: "2K",
      exportWidth: 64,
      exportHeight: 64,
    }],
  }],
};

// ---------- storage helpers ----------
async function ensureSetup() {
  await fs.mkdir(REFS_DIR, { recursive: true });
  await fs.mkdir(OUTPUTS_DIR, { recursive: true });
  await fs.mkdir(FRAMES_DIR, { recursive: true });
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  try { await fs.access(PRESETS_FILE); }
  catch { await fs.writeFile(PRESETS_FILE, JSON.stringify(SEED, null, 2)); }
}
async function readPresets() { return JSON.parse(await fs.readFile(PRESETS_FILE, "utf8")); }
async function writePresets(data) {
  const tmp = PRESETS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, PRESETS_FILE);            // atomic write
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

// ---------- static files ----------
app.use("/references", express.static(REFS_DIR));
app.use("/frames", express.static(FRAMES_DIR));
app.use(express.static(path.join(__dirname, "public")));

await ensureSetup();
app.listen(PORT, () => console.log(`\n  Nephilim Generator -> http://localhost:${PORT}\n`));
