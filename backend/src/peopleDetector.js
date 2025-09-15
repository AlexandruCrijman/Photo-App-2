import { InferenceSession, Tensor } from 'onnxruntime-node';
import fs from 'fs';
import sharp from 'sharp';

let scrfdSession = null;
let arcfaceSession = null;
let osnetSession = null;

export async function getScrfd() {
  if (scrfdSession) return scrfdSession;
  const modelPath = process.env.SCRFD_MODEL_PATH || 'models/scrfd_person_2.5g.onnx';
  if (!fs.existsSync(modelPath)) throw new Error(`SCRFD model not found at ${modelPath}`);
  scrfdSession = await InferenceSession.create(modelPath);
  return scrfdSession;
}

export async function getArcface() {
  if (arcfaceSession) return arcfaceSession;
  const modelPath = process.env.ARCFACE_MODEL_PATH || 'models/arcface_r50.onnx';
  if (!fs.existsSync(modelPath)) throw new Error(`ArcFace model not found at ${modelPath}`);
  arcfaceSession = await InferenceSession.create(modelPath);
  return arcfaceSession;
}

export async function getOsnet() {
  if (osnetSession) return osnetSession;
  const modelPath = process.env.OSNET_MODEL_PATH || 'models/osnet_x0_25.onnx';
  if (!fs.existsSync(modelPath)) throw new Error(`OSNet model not found at ${modelPath}`);
  osnetSession = await InferenceSession.create(modelPath);
  return osnetSession;
}

export async function checkModelsHealth() {
  try {
    await getScrfd();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function hwcToNchwFloat32BgrLetterbox(pixels, width, height) {
  // Convert HWC RGB uint8 -> NCHW BGR float32 normalized
  // Normalize to [0,1]. Some SCRFD variants expect mean/std; adjust if needed later.
  const chw = new Float32Array(3 * width * height);
  let idx = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = pixels[idx++];
      const g = pixels[idx++];
      const b = pixels[idx++];
      const pi = y * width + x;
      // B, G, R order
      chw[0 * width * height + pi] = b / 255;
      chw[1 * width * height + pi] = g / 255;
      chw[2 * width * height + pi] = r / 255;
    }
  }
  return chw;
}

export async function detectFacesScrfd(absImagePath) {
  try {
    const session = await getScrfd();
    const inputName = session.inputNames[0];
    const meta = await sharp(absImagePath).metadata();
    const origW = meta.width || 0;
    const origH = meta.height || 0;
    const target = 640;
    const scale = Math.min(target / Math.max(1, origW), target / Math.max(1, origH));
    const newW = Math.max(1, Math.round(origW * scale));
    const newH = Math.max(1, Math.round(origH * scale));
    const padX = Math.floor((target - newW) / 2);
    const padY = Math.floor((target - newH) / 2);

    const resized = await sharp(absImagePath)
      .resize(target, target, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = resized.info.width; // expect 640
    const height = resized.info.height; // expect 640
    const inputData = hwcToNchwFloat32BgrLetterbox(resized.data, width, height);
    const tensor = new Tensor('float32', inputData, [1, 3, height, width]);
    const outputs = await session.run({ [inputName]: tensor });

    const outNames = Object.keys(outputs);
    const scoreNames = outNames.filter((n) => /score/i.test(n));
    const bboxNames = outNames.filter((n) => /bbox|boxes/i.test(n));

    if (scoreNames.length === 0 || bboxNames.length === 0) {
      return [];
    }

    const scores = outputs[scoreNames[0]].data;
    const bboxes = outputs[bboxNames[0]].data;

    const candidates = [];
    const n = Math.floor(bboxes.length / 4);
    for (let i = 0; i < n; i++) {
      const s = scores[i] ?? 0;
      if (s < 0.3) continue;
      const x1 = bboxes[i * 4 + 0];
      const y1 = bboxes[i * 4 + 1];
      const x2 = bboxes[i * 4 + 2];
      const y2 = bboxes[i * 4 + 3];
      // Map from 640x640 letterboxed space back to original image coords
      let lx = Math.min(x1, x2);
      let ly = Math.min(y1, y2);
      let rx = Math.max(x1, x2);
      let by = Math.max(y1, y2);
      // Remove padding, then inverse scale
      let left = (lx - padX) / (scale || 1);
      let top = (ly - padY) / (scale || 1);
      let right = (rx - padX) / (scale || 1);
      let bottom = (by - padY) / (scale || 1);
      // Clamp to original bounds
      left = Math.max(0, Math.min(left, origW));
      top = Math.max(0, Math.min(top, origH));
      right = Math.max(0, Math.min(right, origW));
      bottom = Math.max(0, Math.min(bottom, origH));
      const w = Math.max(0, right - left);
      const h = Math.max(0, bottom - top);
      if (w <= 1 || h <= 1) continue;
      candidates.push({ left, top, width: w, height: h, score: s });
      if (candidates.length >= 150) break;
    }
    return candidates;
  } catch (e) {
    console.error('SCRFD detect error:', e.message);
    return [];
  }
}

export async function detectPeopleInImage(absImagePath) {
  try {
    const meta = await sharp(absImagePath).metadata();
    const boxes = await detectFacesScrfd(absImagePath);
    return {
      boxes: boxes.map((b) => ({
        left: Math.round(b.left),
        top: Math.round(b.top),
        width: Math.round(b.width),
        height: Math.round(b.height),
        score: b.score || 0
      })),
      imageWidth: meta.width || 0,
      imageHeight: meta.height || 0
    };
  } catch (e) {
    return { boxes: [], imageWidth: 0, imageHeight: 0 };
  }
}


