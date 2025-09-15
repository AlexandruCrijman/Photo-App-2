import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

async function resetDb() {
  // Ensure DB is initialized and clean minimal state for tests
  await pool.query('DELETE FROM share_links');
  // ensure Default exists and is selected
  await pool.query(`UPDATE settings SET current_event_id = (SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1)`);
}

test('set person view password', async () => {
  await resetDb();
  const res = await request(app)
    .post('/settings/person-view-password')
    .send({ password: 'secret123' })
    .expect(200);
  assert.equal(res.body.ok, true);
});

test('create share link for non-existing tag fails', async () => {
  await resetDb();
  await request(app).post('/settings/person-view-password').send({ password: 'x' });
  const res = await request(app)
    .post('/share-links')
    .send({ tag_name: 'Nope' })
    .expect(404);
  assert.equal(res.body.error, 'tag not found in current event');
});

test('create tag, create link, login works', async () => {
  await resetDb();
  await request(app).post('/settings/person-view-password').send({ password: 'secret123' });
  // create a photo and tag it to ensure tag exists in current event
  const p = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('x.jpg','x.jpg','image/jpeg',1,(SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1)) RETURNING id`);
  const photoId = p.rows[0].id;
  await request(app).post(`/photos/${photoId}/tags`).send({ tag: 'Alex' }).expect(200);

  const create = await request(app).post('/share-links').send({ tag_name: 'Alex' }).expect(201);
  assert.ok(create.body.url);
  const token = create.body.url.split('/').pop();

  // login with wrong password
  await request(app).post(`/share/${token}/login`).send({ password: 'wrong' }).expect(401);
  // login with correct password
  const login = await request(app).post(`/share/${token}/login`).send({ password: 'secret123' }).expect(200);
  assert.equal(login.body.ok, true);

  // Get me should show person scope
  const agent = request.agent(app);
  await agent.post(`/share/${token}/login`).send({ password: 'secret123' }).expect(200);
  const me = await agent.get('/me').expect(200);
  assert.ok(me.body.personScope);
  assert.ok(me.body.personScope.eventId);
  assert.ok(me.body.personScope.tagId);
});

test('person scope filters photos/tags/stats and blocks writes', async () => {
  await resetDb();
  await request(app).post('/settings/person-view-password').send({ password: 'secret123' });
  const eventIdRow = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
  const eventId = eventIdRow.rows[0].id;

  // Create two photos and tag them differently
  const p1 = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('a.jpg','a.jpg','image/jpeg',1,$1) RETURNING id`, [eventId]);
  const p2 = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('b.jpg','b.jpg','image/jpeg',1,$1) RETURNING id`, [eventId]);
  const id1 = p1.rows[0].id; const id2 = p2.rows[0].id;
  await request(app).post(`/photos/${id1}/tags`).send({ tag: 'Alex' }).expect(200);
  await request(app).post(`/photos/${id2}/tags`).send({ tag: 'Bob' }).expect(200);

  // Create share for Alex
  const share = await request(app).post('/share-links').send({ tag_name: 'Alex' }).expect(201);
  const token = share.body.url.split('/').pop();

  // Login as person (Alex)
  const agent = request.agent(app);
  await agent.post(`/share/${token}/login`).send({ password: 'secret123' }).expect(200);

  // Photos should include only Alex-tagged photos
  const photos = await agent.get('/photos').expect(200);
  const ids = (Array.isArray(photos.body) ? photos.body : photos.body.items).map((p) => p.id);
  assert.ok(ids.includes(id1));
  assert.equal(ids.includes(id2), false);

  // Tags should include only Alex
  const tags = await agent.get('/tags').expect(200);
  assert.equal(tags.body.length, 1);
  assert.equal((tags.body[0].name || tags.body[0].NAME || tags.body[0].tag || tags.body[0]).toLowerCase(), 'alex');

  // Stats should reflect only Alex photos
  const stats = await agent.get('/stats').expect(200);
  assert.equal(stats.body.total >= 1, true);

  // Writes blocked in person scope
  await agent.post('/photos').expect(403);
  await agent.post(`/photos/${id1}/tags`).send({ tag: 'X' }).expect(403);
  await agent.delete('/photos').send({ ids: [id1] }).expect(403);
});

test('revoking a link prevents new logins', async () => {
  await resetDb();
  await request(app).post('/settings/person-view-password').send({ password: 'secret123' });
  const ev = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
  const eventId = ev.rows[0].id;
  const p = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('c.jpg','c.jpg','image/jpeg',1,$1) RETURNING id`, [eventId]);
  await request(app).post(`/photos/${p.rows[0].id}/tags`).send({ tag: 'Alex' }).expect(200);
  const create = await request(app).post('/share-links').send({ tag_name: 'Alex' }).expect(201);
  const id = create.body.id; const token = create.body.url.split('/').pop();
  // Revoke
  await request(app).delete(`/share-links/${id}`).expect(200);
  // Login should fail with invalid link
  await request(app).post(`/share/${token}/login`).send({ password: 'secret123' }).expect(404);
});

test('same tag name in different events is isolated by link', async () => {
  await resetDb();
  await request(app).post('/settings/person-view-password').send({ password: 'secret123' });
  // Default event: photo tagged Alex
  const def = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
  const defId = def.rows[0].id;
  const pDef = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('d.jpg','d.jpg','image/jpeg',1,$1) RETURNING id`, [defId]);
  await request(app).post(`/photos/${pDef.rows[0].id}/tags`).send({ tag: 'Alex' });

  // Create second event with a unique name and switch to it
  const uniqName = `EventB_${Date.now()}_${Math.floor(Math.random()*100000)}`;
  const e2 = await request(app).post('/events').send({ name: uniqName }).expect(201);
  await request(app).post('/settings/event').send({ event_id: e2.body.id }).expect(200);

  // Add different photo tagged Alex in EventB
  const pE2 = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('e.jpg','e.jpg','image/jpeg',1,$1) RETURNING id`, [e2.body.id]);
  await request(app).post(`/photos/${pE2.rows[0].id}/tags`).send({ tag: 'Alex' });

  // Create share link for Alex in EventB
  const shareE2 = await request(app).post('/share-links').send({ tag_name: 'Alex' }).expect(201);
  const token = shareE2.body.url.split('/').pop();

  // Login and verify only EventB photo appears
  const agent = request.agent(app);
  await agent.post(`/share/${token}/login`).send({ password: 'secret123' }).expect(200);
  const photos = await agent.get('/photos').expect(200);
  const ids = (Array.isArray(photos.body) ? photos.body : photos.body.items).map((p) => p.id);
  // Should include EventB photo id, not Default event id
  if (!(ids.includes(pE2.rows[0].id) && !ids.includes(pDef.rows[0].id))) {
    throw new Error('Event isolation failed for share link');
  }
});

test('share info endpoint exposes tag and event names only', async () => {
  await resetDb();
  await request(app).post('/settings/person-view-password').send({ password: 'secret123' });
  const def = await pool.query(`SELECT id, name FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
  const defId = def.rows[0].id;
  const p = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('f.jpg','f.jpg','image/jpeg',1,$1) RETURNING id`, [defId]);
  await request(app).post(`/photos/${p.rows[0].id}/tags`).send({ tag: 'Chloe' });
  const create = await request(app).post('/share-links').send({ tag_name: 'Chloe' }).expect(201);
  const token = create.body.url.split('/').pop();
  const info = await request(app).get(`/share/${token}/info`).expect(200);
  assert.equal(typeof info.body.tag_name, 'string');
  assert.equal(typeof info.body.event_name, 'string');
});

test('rate limiting on share login', async () => {
  await resetDb();
  await request(app).post('/settings/person-view-password').send({ password: 'secret123' });
  const def = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
  const defId = def.rows[0].id;
  const p = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('g.jpg','g.jpg','image/jpeg',1,$1) RETURNING id`, [defId]);
  await request(app).post(`/photos/${p.rows[0].id}/tags`).send({ tag: 'Bob' });
  const create = await request(app).post('/share-links').send({ tag_name: 'Bob' }).expect(201);
  const token = create.body.url.split('/').pop();
  // 3 wrong attempts (in test config MAX_FAILED=3)
  await request(app).post(`/share/${token}/login`).send({ password: 'wrong' }).expect(401);
  await request(app).post(`/share/${token}/login`).send({ password: 'wrong' }).expect(401);
  const rl = await request(app).post(`/share/${token}/login`).send({ password: 'wrong' }).expect(429);
  if (rl.body.code !== 'RATE_LIMIT') throw new Error('Expected rate limit code');
});

test('invalid link and password-not-set responses', async () => {
  await resetDb();
  // Invalid link
  await request(app).post('/share/does-not-exist/login').send({ password: 'x' }).expect(404);

  // No password configured
  // Ensure a tag and link exist
  const def = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
  const p = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('h.jpg','h.jpg','image/jpeg',1,$1) RETURNING id`, [def.rows[0].id]);
  await request(app).post(`/photos/${p.rows[0].id}/tags`).send({ tag: 'NoPass' });
  const create = await request(app).post('/share-links').send({ tag_name: 'NoPass' }).expect(201);
  const token = create.body.url.split('/').pop();
  // Clear password
  await request(app).post('/settings/person-view-password').send({ password: null }).expect(200);
  await request(app).post(`/share/${token}/login`).send({ password: 'anything' }).expect(503);
});

test('expired link returns 410', async () => {
  await resetDb();
  await request(app).post('/settings/person-view-password').send({ password: 'secret123' });
  const def = await pool.query(`SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1`);
  const p = await pool.query(`INSERT INTO photos (filename, original_name, mime_type, size_bytes, event_id) VALUES ('i.jpg','i.jpg','image/jpeg',1,$1) RETURNING id`, [def.rows[0].id]);
  await request(app).post(`/photos/${p.rows[0].id}/tags`).send({ tag: 'Expire' });
  const create = await request(app).post('/share-links').send({ tag_name: 'Expire' }).expect(201);
  const token = create.body.url.split('/').pop();
  // Expire the link
  await pool.query(`UPDATE share_links SET expires_at = now() - interval '1 second' WHERE token = $1`, [token]);
  await request(app).post(`/share/${token}/login`).send({ password: 'secret123' }).expect(410);
});


