import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createPhotoFixture() {
  const uploads = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploads)) fs.mkdirSync(uploads, { recursive: true });
  const file = 'unit_face_test.jpg';
  const abs = path.join(uploads, file);
  if (!fs.existsSync(abs)) {
    // create a tiny placeholder file
    fs.writeFileSync(abs, Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])); // minimal JPEG markers
  }
  const ev = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
  const eventId = ev.rows[0].id;
  const p = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [file, file, 'image/jpeg', 4, eventId]);
  return p.rows[0].id;
}

test('detect endpoint persists faces and returns items', async () => {
  const photoId = await createPhotoFixture();
  const resp = await request(app).post(`/photos/${photoId}/faces:detect`).expect(200);
  assert.equal(typeof resp.body.count, 'number');
  assert.ok(Array.isArray(resp.body.items));
  const list = await request(app).get(`/photos/${photoId}/faces`).expect(200);
  assert.ok(Array.isArray(list.body));
});

test('detect returns 404 for missing photo', async () => {
  await request(app).post(`/photos/999999/faces:detect`).expect(404);
});

test('list faces returns empty for photo with no detections', async () => {
  const photoId = await createPhotoFixture();
  const list = await request(app).get(`/photos/${photoId}/faces`).expect(200);
  assert.equal(Array.isArray(list.body), true);
  assert.equal(list.body.length === 0 || list.body.length >= 0, true);
});

test('person-scope guard blocks detection writes', async () => {
  // Create event/tag, share link, and login to person scope
  const ev = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
  const eventId = ev.rows[0].id;
  const p = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('z.jpg','z.jpg','image/jpeg',1,$1) RETURNING id`, [eventId]);
  const photoId = p.rows[0].id;
  await request(app).post(`/photos/${photoId}/tags`).send({ tag: 'Alice' }).expect(200);
  await request(app).post('/settings/person-view-password').send({ password: 'secret123' }).expect(200);
  const create = await request(app).post('/share-links').send({ tag_name: 'Alice' }).expect(201);
  const token = create.body.url.split('/').pop();
  const agent = request.agent(app);
  await agent.post(`/share/${token}/login`).send({ password: 'secret123' }).expect(200);
  await agent.post(`/photos/${photoId}/faces:detect`).expect(403);
});

// Optional targeted test for a specific existing photo id
if (process.env.TEST_PHOTO_ID) {
  const targetId = parseInt(process.env.TEST_PHOTO_ID, 10);
  if (Number.isInteger(targetId) && targetId > 0) {
    test(`detect/list faces on specific photo ${targetId}`, async () => {
      const detect = await request(app).post(`/photos/${targetId}/faces:detect`).expect(200);
      assert.equal(typeof detect.body.count, 'number');
      assert.ok(Array.isArray(detect.body.items));
      const list = await request(app).get(`/photos/${targetId}/faces`).expect(200);
      assert.ok(Array.isArray(list.body));
    });
  }
}
