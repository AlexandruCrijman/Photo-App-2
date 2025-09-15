import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initializeDatabase, pool, listPhotosWithTags, listAllTagsWithCounts, getPhotoWithTags, listPhotosWithTagsPaginated } from './db.js';
import sharp from 'sharp';
import archiver from 'archiver';
import OpenAI from 'openai';
import { detectPeopleInImage } from './peopleDetector.js';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';

dotenv.config();

const app = express();
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

app.get('/health', (req, res) => {
	res.json({ status: 'ok', uptime: process.uptime() });
});

// Static files (uploads)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', immutable: true }));

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (_req, file, cb) {
    const timestamp = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${timestamp}_${safe}`);
  },
});
const upload = multer({ storage });

// Initialize DB
initializeDatabase().catch((err) => {
  console.error('DB init error', err);
  process.exit(1);
});

// Resolve current event
async function getCurrentEventId() {
  const ev = await pool.query(`SELECT current_event_id FROM settings WHERE id = 1`);
  let eventId = ev.rows?.[0]?.current_event_id || null;
  if (!eventId) {
    const def = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
    eventId = def.rows?.[0]?.id;
  }
  return eventId;
}

// Events API
app.get('/events', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name FROM events ORDER BY name ASC`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to list events' });
  }
});

app.post('/events', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const exists = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER($1)`, [name]);
    if (exists.rows[0]) return res.status(409).json({ error: 'Event already exists' });
    const ins = await pool.query(`INSERT INTO events (name) VALUES ($1) RETURNING id, name`, [name]);
    res.status(201).json(ins.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Failed to create event' });
  }
});

app.delete('/events/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    await pool.query('BEGIN');
    // If deleting current event, switch to Default after deletion
    const cur = await getCurrentEventId();
    await pool.query(`DELETE FROM events WHERE id = $1`, [id]);
    if (cur === id) {
      const def = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
      const defId = def.rows?.[0]?.id || null;
      await pool.query(`UPDATE settings SET current_event_id = $1 WHERE id = 1`, [defId]);
    }
    await pool.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

app.post('/settings/event', async (req, res) => {
  try {
    const id = parseInt(req.body?.event_id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid event_id' });
    await pool.query(`UPDATE settings SET current_event_id = $1, updated_at = now() WHERE id = 1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to set current event' });
  }
});

// AI client (lazy init)
let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

app.get('/ai/health', async (_req, res) => {
  try {
    // Minimal call: list models to verify auth (or use a cheap noop if available)
    const client = getOpenAI();
    await client.models.list({ limit: 1 });
    res.json({ ok: true });
  } catch (e) {
    console.error('AI health error', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Detect people (bounding boxes) in a photo
app.post('/photos/:photoId/detect-people', async (req, res) => {
  try {
    const { photoId } = req.params;
    const { rows } = await pool.query('SELECT * FROM photos WHERE id = $1', [photoId]);
    const photo = rows[0];
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const fileName = photo.preview_filename || photo.filename;
    const absPath = path.join(uploadsDir, fileName);
    if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Image file not found on server' });
    const result = await detectPeopleInImage(absPath);
    // Do not persist yet; frontend will show overlays. Persistence added later per instruction.
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to detect people' });
  }
});

// Stats: total photos and completed, optionally filtered by tags (ANY-of)
app.get('/stats', async (req, res) => {
  try {
    const scope = readPersonScope(req);
    const eventId = scope?.eventId ?? await getCurrentEventId();
    const tagsParam = (req.query.tags || '').toString().trim();
    if (scope) {
      const { rows } = await pool.query(
        `WITH filtered AS (
           SELECT DISTINCT p.id, p.completed
           FROM photos p
           JOIN photo_tags pt ON pt.photo_id = p.id
           WHERE p.event_id = $1 AND pt.tag_id = $2
         )
         SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE completed)::int AS completed
         FROM filtered`,
        [scope.eventId, scope.tagId]
      );
      return res.json(rows[0]);
    }
    if (tagsParam) {
      const tags = tagsParam
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (tags.length === 0) {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE completed)::int AS completed FROM photos WHERE event_id = $1`, [eventId]);
        return res.json(rows[0]);
      }
      const { rows } = await pool.query(
        `WITH filtered AS (
           SELECT DISTINCT p.id, p.completed
           FROM photos p
           JOIN photo_tags pt ON pt.photo_id = p.id
           JOIN tags t ON t.id = pt.tag_id
           WHERE p.event_id = $2 AND t.event_id = $2 AND LOWER(t.name) = ANY($1::text[])
         )
         SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE completed)::int AS completed
         FROM filtered`,
        [tags, eventId]
      );
      return res.json(rows[0]);
    } else {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE completed)::int AS completed
         FROM photos WHERE event_id = $1`,
        [eventId]
      );
      return res.json(rows[0]);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Photos endpoints
app.get('/photos', async (req, res) => {
  try {
    const scope = readPersonScope(req);
    const eventId = scope?.eventId ?? await getCurrentEventId();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const cursor = req.query.cursor ? parseInt(req.query.cursor) : undefined;
    if (cursor || req.query.limit) {
      const { rows } = await pool.query(
        `SELECT p.*, COALESCE(json_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL), '[]') AS tags
         FROM photos p
         LEFT JOIN photo_tags pt ON pt.photo_id = p.id
         LEFT JOIN tags t ON t.id = pt.tag_id
         WHERE p.event_id = $1 ${scope ? 'AND EXISTS (SELECT 1 FROM photo_tags x WHERE x.photo_id = p.id AND x.tag_id = $2)' : ''} ${cursor ? (scope ? 'AND p.id < $3' : 'AND p.id < $2') : ''}
         GROUP BY p.id
         ORDER BY p.id DESC
         LIMIT ${cursor ? (scope ? '$4' : '$3') : (scope ? '$3' : '$2')}`,
        scope
          ? (cursor ? [eventId, scope.tagId, cursor, limit] : [eventId, scope.tagId, limit])
          : (cursor ? [eventId, cursor, limit] : [eventId, limit])
      );
      const nextCursor = rows.length > 0 ? rows[rows.length - 1].id : null;
      res.json({ items: rows, nextCursor });
    } else {
      const { rows } = await pool.query(
        `SELECT p.*, COALESCE(json_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL), '[]') AS tags
         FROM photos p
         LEFT JOIN photo_tags pt ON pt.photo_id = p.id
         LEFT JOIN tags t ON t.id = pt.tag_id
         WHERE p.event_id = $1 ${scope ? 'AND EXISTS (SELECT 1 FROM photo_tags x WHERE x.photo_id = p.id AND x.tag_id = $2)' : ''}
         GROUP BY p.id
         ORDER BY p.id DESC`,
        scope ? [eventId, scope.tagId] : [eventId]
      );
      res.json(rows);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list photos' });
  }
});

// Mark photo as completed
app.post('/photos/:photoId/complete', async (req, res) => {
  try {
    const { photoId } = req.params;
    await pool.query(`UPDATE photos SET completed = TRUE WHERE id = $1`, [photoId]);
    const photo = await getPhotoWithTags(photoId);
    res.json(photo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark completed' });
  }
});

// Mark photo as not completed
app.post('/photos/:photoId/incomplete', async (req, res) => {
  try {
    const { photoId } = req.params;
    await pool.query(`UPDATE photos SET completed = FALSE WHERE id = $1`, [photoId]);
    const photo = await getPhotoWithTags(photoId);
    res.json(photo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark incomplete' });
  }
});

app.post('/photos', requireNoWritesInPersonScope, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const eventId = await getCurrentEventId();
    const { filename, originalname, mimetype, size, path: filePath } = req.file;

    // Generate preview and thumbnail
    const previewName = filename.replace(/(\.[^.]+)?$/, '_preview$1');
    const thumbName = filename.replace(/(\.[^.]+)?$/, '_thumb$1');
    const previewPath = path.join(uploadsDir, previewName);
    const thumbPath = path.join(uploadsDir, thumbName);
    const meta = await sharp(filePath).metadata();
    const width = meta.width || null;
    const height = meta.height || null;
    await sharp(filePath).resize({ width: 1600, height: 1600, fit: 'inside' }).toFile(previewPath);
    await sharp(filePath).resize({ width: 256, height: 256, fit: 'cover' }).toFile(thumbPath);

    const result = await pool.query(
      `INSERT INTO photos (filename, thumb_filename, preview_filename, original_name, mime_type, size_bytes, width, height, event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [filename, thumbName, previewName, originalname, mimetype, size, width, height, eventId]
    );
    const photo = await getPhotoWithTags(result.rows[0].id);
    res.status(201).json(photo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});
// Generate description for a photo via OpenAI (uses preview if available)
app.post('/photos/:photoId/describe', requireNoWritesInPersonScope, async (req, res) => {
  try {
    const { photoId } = req.params;
    // Use saved settings if present
    const settings = await pool.query('SELECT system_prompt, model FROM settings WHERE id = 1');
    const model = (settings.rows[0]?.model) || process.env.OPENAI_IMAGE_CAPTION_MODEL || 'gpt-4o-mini';
    const systemPrompt = (settings.rows[0]?.system_prompt) || 'You are a helpful photo captioning assistant.';

    const { rows } = await pool.query('SELECT * FROM photos WHERE id = $1', [photoId]);
    const photo = rows[0];
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    const fileName = photo.preview_filename || photo.filename;
    const absPath = path.join(uploadsDir, fileName);
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'Image file not found on server' });
    }
    const buffer = fs.readFileSync(absPath);
    const ext = path.extname(fileName).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    const client = getOpenAI();
    const userPrompt = 'Provide a short, plain-English description for this photo. 1 sentence. Capturing the essence of the photo and the feelings it evokes.';
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ] }
      ]
    });
    const text = resp.choices?.[0]?.message?.content?.trim() || '';
    await pool.query(
      `UPDATE photos SET description = $1, description_model = $2, described_at = now() WHERE id = $3`,
      [text, model, photoId]
    );
    const updated = await getPhotoWithTags(photoId);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to describe photo' });
  }
});

// Identify people present in a photo via OpenAI (returns structured JSON)
app.post('/photos/:photoId/people', requireNoWritesInPersonScope, async (req, res) => {
  try {
    const { photoId } = req.params;
    // Use saved settings if present
    const settings = await pool.query('SELECT system_prompt, model FROM settings WHERE id = 1');
    const model = (settings.rows[0]?.model) || process.env.OPENAI_IMAGE_CAPTION_MODEL || 'gpt-4o-mini';
    const baseSystem = (settings.rows[0]?.system_prompt) || 'You are a helpful photo analysis assistant.';

    const { rows } = await pool.query('SELECT * FROM photos WHERE id = $1', [photoId]);
    const photo = rows[0];
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    const fileName = photo.preview_filename || photo.filename;
    const absPath = path.join(uploadsDir, fileName);
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'Image file not found on server' });
    }
    const buffer = fs.readFileSync(absPath);
    const ext = path.extname(fileName).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    const client = getOpenAI();
    const systemPrompt = `${baseSystem}\nReturn ONLY strict JSON as specified. No extra commentary.`;
    const userPrompt = `Identify and list every distinct person visible in the photo. For each person, include a concise description covering apparent age range, gender presentation if inferable, clothing, hair, accessories, and distinguishing features. Do NOT guess real names.\n\nReturn strict JSON with this schema (no markdown): {"persons":[{"description":"string"}]}. If no people are present, return {"persons":[]}.`;

    const resp = await client.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ] }
      ]
    });

    let payload = { persons: [] };
    try {
      const raw = resp.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.persons)) payload = { persons: parsed.persons };
    } catch (_) {}
    return res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to identify people' });
  }
});


// Tags endpoints
app.get('/tags', async (_req, res) => {
  try {
    const scope = readPersonScope(_req);
    const eventId = scope?.eventId ?? await getCurrentEventId();
    let rows;
    if (scope) {
      const r = await pool.query(`SELECT name, 1::int AS count FROM tags WHERE id = $1 AND event_id = $2`, [scope.tagId, eventId]);
      rows = r.rows;
    } else {
      const r = await pool.query(`
        SELECT t.name, COUNT(pt.photo_id) AS count
        FROM tags t
        LEFT JOIN photo_tags pt ON pt.tag_id = t.id
        WHERE t.event_id = $1
        GROUP BY t.id
        ORDER BY t.name ASC
      `, [eventId]);
      rows = r.rows;
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list tags' });
  }
});

// Delete a tag by name (case-insensitive). Cascades to photo_tags via FK.
app.delete('/tags/:name', async (req, res) => {
  try {
    const { name } = req.params;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
    const eventId = await getCurrentEventId();
    const tag = await pool.query(`SELECT id FROM tags WHERE event_id = $2 AND LOWER(name) = LOWER($1) LIMIT 1`, [name.trim(), eventId]);
    if (!tag.rows[0]) return res.status(404).json({ error: 'tag not found' });
    const id = tag.rows[0].id;
    await pool.query('BEGIN');
    // photo_tags has ON DELETE CASCADE, but deleting explicit relations is safe too
    await pool.query(`DELETE FROM tags WHERE id = $1`, [id]);
    await pool.query('COMMIT');
    const rows = await listAllTagsWithCounts();
    res.json({ ok: true, tags: rows });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error(err);
    res.status(500).json({ error: 'Failed to delete tag' });
  }
});

// Rename a tag (case-insensitive). If target exists, merge into it.
app.put('/tags/:oldName', async (req, res) => {
  try {
    const { oldName } = req.params;
    const { newName } = req.body || {};
    if (!oldName || typeof oldName !== 'string') return res.status(400).json({ error: 'oldName required' });
    if (!newName || typeof newName !== 'string') return res.status(400).json({ error: 'newName required' });
    const fromName = oldName.trim();
    const toName = newName.trim();
    if (!fromName || !toName) return res.status(400).json({ error: 'names cannot be empty' });

    // Find source and destination tags (case-insensitive)
    const eventId = await getCurrentEventId();
    const src = await pool.query(`SELECT id, name FROM tags WHERE event_id = $2 AND LOWER(name) = LOWER($1) LIMIT 1`, [fromName, eventId]);
    if (!src.rows[0]) return res.status(404).json({ error: 'source tag not found' });
    const srcId = src.rows[0].id;
    const dest = await pool.query(`SELECT id, name FROM tags WHERE event_id = $2 AND LOWER(name) = LOWER($1) LIMIT 1`, [toName, eventId]);

    await pool.query('BEGIN');
    let destId;
    if (dest.rows[0]) {
      // Destination exists: merge photo_tags and delete source tag
      destId = dest.rows[0].id;
      // Move associations (avoid duplicates with ON CONFLICT DO NOTHING)
      await pool.query(
        `INSERT INTO photo_tags (photo_id, tag_id)
         SELECT pt.photo_id, $1
         FROM photo_tags pt
         WHERE pt.tag_id = $2
         ON CONFLICT DO NOTHING`,
        [destId, srcId]
      );
      // Delete old relations and old tag
      await pool.query(`DELETE FROM photo_tags WHERE tag_id = $1`, [srcId]);
      await pool.query(`DELETE FROM tags WHERE id = $1`, [srcId]);
    } else {
      // Destination does not exist: update tag name (preserve casing as provided)
      const updated = await pool.query(`UPDATE tags SET name = $1 WHERE id = $2 RETURNING id, name`, [toName, srcId]);
      destId = updated.rows[0].id;
    }
    await pool.query('COMMIT');

    // Return updated tags with counts
    const rows = await listAllTagsWithCounts();
    res.json({ ok: true, tags: rows });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error(err);
    // Handle unique index violation gracefully
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'A tag with this name already exists' });
    }
    res.status(500).json({ error: 'Failed to rename tag' });
  }
});

// Settings endpoints
app.get('/settings', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.system_prompt, s.model, s.current_event_id, e.name AS current_event_name
       FROM settings s
       LEFT JOIN events e ON e.id = s.current_event_id
       WHERE s.id = 1`
    );
    const fallback = { system_prompt: '', model: process.env.OPENAI_IMAGE_CAPTION_MODEL || 'gpt-4o-mini', current_event_id: null, current_event_name: 'Default' };
    res.json(rows[0] || fallback);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

app.post('/settings', async (req, res) => {
  try {
    const { system_prompt, model } = req.body || {};
    await pool.query(
      `UPDATE settings SET system_prompt = $1, model = $2, updated_at = now() WHERE id = 1`,
      [system_prompt || '', model || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Set or clear person-view password
app.post('/settings/person-view-password', async (req, res) => {
  try {
    const { password } = req.body || {};
    let hash = null;
    if (password && typeof password === 'string' && password.trim()) {
      const salt = await bcrypt.genSalt(10);
      hash = await bcrypt.hash(password.trim(), salt);
    }
    await pool.query(`UPDATE settings SET person_view_password_hash = $1, updated_at = now() WHERE id = 1`, [hash]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to set password' });
  }
});

function generateToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Create share link for a tag in current event
app.post('/share-links', async (req, res) => {
  try {
    const { tag_name } = req.body || {};
    if (!tag_name || typeof tag_name !== 'string') return res.status(400).json({ error: 'tag_name required' });
    const eventId = await getCurrentEventId();
    const tagRow = await pool.query(`SELECT id FROM tags WHERE event_id = $2 AND LOWER(name) = LOWER($1)`, [tag_name.trim(), eventId]);
    const tagId = tagRow.rows[0]?.id;
    if (!tagId) return res.status(404).json({ error: 'tag not found in current event' });
    const token = generateToken(32);
    // Revoke existing active link if unique constraint is desired
    await pool.query(`UPDATE share_links SET revoked = TRUE WHERE event_id = $1 AND tag_id = $2 AND revoked = FALSE`, [eventId, tagId]);
    const ins = await pool.query(`INSERT INTO share_links (event_id, tag_id, token) VALUES ($1, $2, $3) RETURNING id, token`, [eventId, tagId, token]);
    const id = ins.rows[0].id;
    const feOrigin = process.env.FRONTEND_ORIGIN;
    const url = `${feOrigin || `${req.protocol}://${req.get('host')}`.replace(':4000', ':5173')}/share/${token}`;
    res.status(201).json({ id, token, url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// Bulk create share links for all tags without an active link in current event
app.post('/share-links/bulk', async (req, res) => {
  try {
    const eventId = await getCurrentEventId();
    const feOrigin = process.env.FRONTEND_ORIGIN;
    const base = (hostReq) => `${feOrigin || `${hostReq.protocol}://${hostReq.get('host')}`.replace(':4000', ':5173')}`;

    // Get all tag ids for current event
    const { rows: allTags } = await pool.query(`SELECT id, name FROM tags WHERE event_id = $1`, [eventId]);
    if (allTags.length === 0) return res.json({ ok: true, created: [], createdCount: 0, skippedCount: 0 });

    // Get tag_ids that already have an active link
    const { rows: existing } = await pool.query(`SELECT tag_id FROM share_links WHERE event_id = $1 AND revoked = FALSE`, [eventId]);
    const existingSet = new Set(existing.map((r) => r.tag_id));

    const toCreate = allTags.filter((t) => !existingSet.has(t.id));
    if (toCreate.length === 0) return res.json({ ok: true, created: [], createdCount: 0, skippedCount: allTags.length });

    const created = [];
    await pool.query('BEGIN');
    try {
      for (const t of toCreate) {
        const token = generateToken(32);
        const ins = await pool.query(`INSERT INTO share_links (event_id, tag_id, token) VALUES ($1, $2, $3) RETURNING id, token`, [eventId, t.id, token]);
        created.push({ id: ins.rows[0].id, tag_name: t.name, token, url: `${base(res.req)}/share/${token}` });
      }
      await pool.query('COMMIT');
    } catch (e) {
      try { await pool.query('ROLLBACK'); } catch {}
      throw e;
    }

    res.json({ ok: true, created, createdCount: created.length, skippedCount: allTags.length - created.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to bulk create share links' });
  }
});

// Revoke share link
app.delete('/share-links/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    await pool.query(`UPDATE share_links SET revoked = TRUE WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to revoke share link' });
  }
});

// List active share links for current event (admin)
app.get('/share-links', async (_req, res) => {
  try {
    const eventId = await getCurrentEventId();
    const feOrigin = process.env.FRONTEND_ORIGIN;
    const base = (hostReq) => `${feOrigin || `${hostReq.protocol}://${hostReq.get('host')}`.replace(':4000', ':5173')}`;
    const { rows } = await pool.query(
      `SELECT sl.id, sl.token, t.name AS tag_name
       FROM share_links sl
       JOIN tags t ON t.id = sl.tag_id
       WHERE sl.event_id = $1 AND sl.revoked = FALSE
       ORDER BY t.name ASC, sl.id DESC`,
      [eventId]
    );
    const data = rows.map((r) => ({ id: r.id, tag_name: r.tag_name, token: r.token, url: `${base(res.req)}/share/${r.token}` }));
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list share links' });
  }
});

// In-memory session for simplicity (can be moved to Redis/DB if needed)
const personSessions = new Map(); // sessionId -> { eventId, tagId, shareId, exp }
// Simple in-memory rate limiting for share login
const failedLoginMap = new Map(); // key -> { count, firstAt, lockUntil }
const MAX_FAILED = process.env.NODE_ENV === 'test' ? 3 : 5;
const LOCK_MS = process.env.NODE_ENV === 'test' ? 2000 : 10 * 60 * 1000;

function setPersonCookie(res, sessionId) {
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  res.cookie('person_session', sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 12 * 60 * 60 * 1000
  });
}

app.post('/share/:token/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const rateKey = `${clientIp}|${req.params.token}`;
    const now = Date.now();
    const rate = failedLoginMap.get(rateKey) || { count: 0, firstAt: now, lockUntil: 0 };
    if (rate.lockUntil && rate.lockUntil > now) {
      const retryAfter = Math.ceil((rate.lockUntil - now) / 1000);
      return res.status(429).json({ error: 'Too many attempts. Try again later.', code: 'RATE_LIMIT', retry_after: retryAfter });
    }
    const sl = await pool.query(`SELECT sl.id, sl.event_id, sl.tag_id, sl.revoked, sl.expires_at FROM share_links sl WHERE token = $1`, [req.params.token]);
    const link = sl.rows[0];
    if (!link || link.revoked) return res.status(404).json({ error: 'Invalid link', code: 'INVALID_LINK' });
    if (link.expires_at && new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired', code: 'LINK_EXPIRED' });
    const s = await pool.query(`SELECT person_view_password_hash FROM settings WHERE id = 1`);
    const hash = s.rows[0]?.person_view_password_hash;
    if (!hash) return res.status(503).json({ error: 'Access password not configured', code: 'PASSWORD_NOT_SET' });
    const ok = await bcrypt.compare(String(password || ''), hash);
    if (!ok) {
      rate.count += 1;
      if (rate.count >= MAX_FAILED) {
        rate.lockUntil = now + LOCK_MS;
        failedLoginMap.set(rateKey, rate);
        const retryAfter = Math.ceil(LOCK_MS / 1000);
        return res.status(429).json({ error: 'Too many attempts. Try again later.', code: 'RATE_LIMIT', retry_after: retryAfter });
      }
      failedLoginMap.set(rateKey, rate);
      return res.status(401).json({ error: 'Invalid password', code: 'INVALID_PASSWORD', remaining_attempts: Math.max(0, MAX_FAILED - rate.count) });
    }
    const sid = generateToken(24);
    const exp = Date.now() + 12 * 60 * 60 * 1000;
    personSessions.set(sid, { eventId: link.event_id, tagId: link.tag_id, shareId: link.id, exp });
    setPersonCookie(res, sid);
    // Reset rate state on success
    failedLoginMap.delete(rateKey);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Public info about a share link (no images)
app.get('/share/:token/info', async (req, res) => {
  try {
    const { token } = req.params;
    const q = await pool.query(
      `SELECT sl.id, sl.revoked, sl.expires_at, t.name AS tag_name, e.name AS event_name
       FROM share_links sl
       JOIN tags t ON t.id = sl.tag_id
       JOIN events e ON e.id = sl.event_id
       WHERE sl.token = $1`,
      [token]
    );
    const row = q.rows[0];
    if (!row || row.revoked) return res.status(404).json({ error: 'Invalid link' });
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired' });
    return res.json({ tag_name: row.tag_name, event_name: row.event_name });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to fetch link info' });
  }
});

app.get('/me', (req, res) => {
  try {
    const sid = req.cookies?.person_session;
    if (!sid) return res.json({ personScope: null });
    const sess = personSessions.get(sid);
    if (!sess || sess.exp < Date.now()) {
      personSessions.delete(sid);
      return res.json({ personScope: null });
    }
    return res.json({ personScope: { eventId: sess.eventId, tagId: sess.tagId } });
  } catch (e) {
    return res.json({ personScope: null });
  }
});

app.post('/auth/logout', (req, res) => {
  try {
    const sid = req.cookies?.person_session;
    if (sid) personSessions.delete(sid);
    res.clearCookie('person_session', { path: '/' });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

// Middleware: person scope
function readPersonScope(req) {
  const sid = req.cookies?.person_session;
  if (!sid) return null;
  const sess = personSessions.get(sid);
  if (!sess || sess.exp < Date.now()) {
    personSessions.delete(sid);
    return null;
  }
  return sess;
}

function requireNoWritesInPersonScope(req, res, next) {
  const scope = readPersonScope(req);
  if (scope) {
    return res.status(403).json({ error: 'Not allowed in personal view' });
  }
  return next();
}

app.post('/photos/:photoId/tags', requireNoWritesInPersonScope, async (req, res) => {
  try {
    const { photoId } = req.params;
    const { tag } = req.body;
    if (!tag || typeof tag !== 'string') return res.status(400).json({ error: 'tag required' });
    const normalized = tag.trim();
    if (!normalized) return res.status(400).json({ error: 'tag required' });

    // Case-insensitive lookup for existing tag in current event; keep existing casing if found
    const eventId = await getCurrentEventId();
    const existing = await pool.query(`SELECT id, name FROM tags WHERE event_id = $2 AND LOWER(name) = LOWER($1) LIMIT 1`, [normalized, eventId]);
    let tagId;
    if (existing.rows[0]?.id) {
      tagId = existing.rows[0].id;
    } else {
      const inserted = await pool.query(`INSERT INTO tags (name, event_id) VALUES ($1, $2) RETURNING id`, [normalized, eventId]);
      tagId = inserted.rows[0].id;
    }
    await pool.query(
      `INSERT INTO photo_tags (photo_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [photoId, tagId]
    );
    const photo = await getPhotoWithTags(photoId);
    res.json(photo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add tag' });
  }
});

app.delete('/photos/:photoId/tags', requireNoWritesInPersonScope, async (req, res) => {
  try {
    const { photoId } = req.params;
    const { tag } = req.body;
    if (!tag || typeof tag !== 'string') return res.status(400).json({ error: 'tag required' });
    const normalized = tag.trim();
    if (!normalized) return res.status(400).json({ error: 'tag required' });

    const eventId = await getCurrentEventId();
    const tagRow = await pool.query(`SELECT id FROM tags WHERE event_id = $2 AND LOWER(name) = LOWER($1)`, [normalized, eventId]);
    const tagId = tagRow.rows[0]?.id;
    if (tagId) {
      await pool.query(`DELETE FROM photo_tags WHERE photo_id = $1 AND tag_id = $2`, [photoId, tagId]);
    }
    const photo = await getPhotoWithTags(photoId);
    res.json(photo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove tag' });
  }
});

// Download all photos for a given tag as a ZIP
app.get('/download', async (req, res) => {
  try {
    const { tag } = req.query;
    if (!tag || typeof tag !== 'string' || !tag.trim()) {
      return res.status(400).json({ error: 'tag query required' });
    }
    const normalized = tag.trim();
    const { rows } = await pool.query(
      `SELECT p.filename
       FROM photos p
       JOIN photo_tags pt ON pt.photo_id = p.id
       JOIN tags t ON t.id = pt.tag_id
       WHERE LOWER(t.name) = LOWER($1)
       ORDER BY p.id DESC`,
      [normalized]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No photos with this tag' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="photos_${normalized}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error(err);
      res.status(500).end();
    });
    archive.pipe(res);
    for (const r of rows) {
      const filePath = path.join(uploadsDir, r.filename);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: r.filename });
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to prepare download' });
  }
});

// Delete one or multiple photos
app.delete('/photos', requireNoWritesInPersonScope, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const idInts = ids.map((x) => parseInt(x)).filter((x) => Number.isInteger(x));
    if (idInts.length === 0) return res.status(400).json({ error: 'no valid ids' });

    const filesResult = await pool.query(
      `SELECT id, filename, thumb_filename, preview_filename FROM photos WHERE id = ANY($1::int[])`,
      [idInts]
    );

    await pool.query('BEGIN');
    await pool.query(`DELETE FROM photo_tags WHERE photo_id = ANY($1::int[])`, [idInts]);
    const del = await pool.query(`DELETE FROM photos WHERE id = ANY($1::int[])`, [idInts]);
    await pool.query('COMMIT');

    for (const row of filesResult.rows) {
      for (const name of [row.filename, row.thumb_filename, row.preview_filename]) {
        if (!name) continue;
        const p = path.join(uploadsDir, name);
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
      }
    }
    res.json({ deletedCount: del.rowCount });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error(err);
    res.status(500).json({ error: 'Failed to delete photos' });
  }
});

// Face detection: store detections (no embeddings yet)
app.post('/photos/:photoId/faces:detect', requireNoWritesInPersonScope, async (req, res) => {
  try {
    const { photoId } = req.params;
    const r = await pool.query('SELECT id, filename, preview_filename FROM photos WHERE id = $1', [photoId]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Photo not found' });
    const fileName = row.preview_filename || row.filename;
    const absPath = path.join(uploadsDir, fileName);
    if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Image file not found on server' });

    // Run detection with a hard timeout to avoid hanging requests
    const mod = await import('./peopleDetector.js');
    const TIMEOUT_MS = parseInt(process.env.DETECT_TIMEOUT_MS || '10000', 10);
    const timeoutSentinel = Symbol('timeout');
    const boxes = await Promise.race([
      mod.detectFacesScrfd(absPath),
      new Promise((resolve) => setTimeout(() => resolve(timeoutSentinel), TIMEOUT_MS))
    ]);

    if (boxes === timeoutSentinel) {
      return res.status(504).json({ error: 'Detection timeout', count: 0, items: [] });
    }

    // Persist detections
    const results = [];
    await pool.query('BEGIN');
    try {
      for (const b of boxes) {
        const ins = await pool.query(
          `INSERT INTO faces (photo_id, bbox, landmarks, yaw, pitch, roll, face_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, bbox, face_score`,
          [photoId, JSON.stringify({ left: b.left, top: b.top, width: b.width, height: b.height }), b.landmarks ? JSON.stringify(b.landmarks) : null, b.yaw ?? null, b.pitch ?? null, b.roll ?? null, b.score ?? null]
        );
        results.push({ id: ins.rows[0].id, bbox: ins.rows[0].bbox, score: ins.rows[0].face_score });
      }
      await pool.query('COMMIT');
    } catch (e) {
      try { await pool.query('ROLLBACK'); } catch {}
      throw e;
    }

    res.json({ count: results.length, items: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Detection failed' });
  }
});

// List stored faces for a photo
app.get('/photos/:photoId/faces', async (req, res) => {
  try {
    const { photoId } = req.params;
    const r = await pool.query(
      `SELECT id, bbox, landmarks, yaw, pitch, roll, recognized_tag_id, face_score, fused_score
       FROM faces WHERE photo_id = $1 ORDER BY id ASC`,
      [photoId]
    );
    res.json(r.rows.map(row => ({
      id: row.id,
      bbox: row.bbox,
      landmarks: row.landmarks,
      yaw: row.yaw,
      pitch: row.pitch,
      roll: row.roll,
      recognized_tag_id: row.recognized_tag_id,
      score: row.face_score,
      fused_score: row.fused_score,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch faces' });
  }
});

export { app };

if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
  });
}


