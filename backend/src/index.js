import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initializeDatabase, pool, listPhotosWithTags, listAllTagsWithCounts, getPhotoWithTags } from './db.js';
import archiver from 'archiver';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
	res.json({ status: 'ok', uptime: process.uptime() });
});

// Static files (uploads)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

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

// Photos endpoints
app.get('/photos', async (_req, res) => {
  try {
    const rows = await listPhotosWithTags();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list photos' });
  }
});

app.post('/photos', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { filename, originalname, mimetype, size } = req.file;
    const result = await pool.query(
      `INSERT INTO photos (filename, original_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [filename, originalname, mimetype, size]
    );
    const photo = await getPhotoWithTags(result.rows[0].id);
    res.status(201).json(photo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// Tags endpoints
app.get('/tags', async (_req, res) => {
  try {
    const rows = await listAllTagsWithCounts();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list tags' });
  }
});

app.post('/photos/:photoId/tags', async (req, res) => {
  try {
    const { photoId } = req.params;
    const { tag } = req.body;
    if (!tag || typeof tag !== 'string') return res.status(400).json({ error: 'tag required' });
    const normalized = tag.trim();
    if (!normalized) return res.status(400).json({ error: 'tag required' });

    const tagInsert = await pool.query(
      `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [normalized]
    );
    const tagId = tagInsert.rows[0].id;
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

app.delete('/photos/:photoId/tags', async (req, res) => {
  try {
    const { photoId } = req.params;
    const { tag } = req.body;
    if (!tag || typeof tag !== 'string') return res.status(400).json({ error: 'tag required' });
    const normalized = tag.trim();
    if (!normalized) return res.status(400).json({ error: 'tag required' });

    const tagRow = await pool.query(`SELECT id FROM tags WHERE name = $1`, [normalized]);
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

const port = process.env.PORT || 4000;
app.listen(port, () => {
	console.log(`API listening on http://localhost:${port}`);
});


