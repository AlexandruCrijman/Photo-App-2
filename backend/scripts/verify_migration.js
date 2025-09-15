import { pool } from '../src/db.js';

async function main() {
  const errors = [];
  const warn = [];

  const q = (text, params) => pool.query(text, params);

  // settings.current_event_id valid
  const s = await q('SELECT current_event_id FROM settings LIMIT 1');
  const currentEventId = s.rows[0]?.current_event_id;
  if (!currentEventId) errors.push('settings.current_event_id is NULL');
  if (currentEventId) {
    const ev = await q('SELECT id FROM events WHERE id=$1', [currentEventId]);
    if (ev.rowCount === 0) errors.push('settings.current_event_id points to missing event');
  }

  // photos.event_id present and valid
  const pNull = await q('SELECT COUNT(*) FROM photos WHERE event_id IS NULL');
  if (Number(pNull.rows[0].count) > 0) errors.push('photos with NULL event_id');
  const pBad = await q('SELECT COUNT(*) FROM photos p LEFT JOIN events e ON p.event_id=e.id WHERE e.id IS NULL');
  if (Number(pBad.rows[0].count) > 0) errors.push('photos with invalid event_id');

  // tags.event_id present and valid
  const tNull = await q('SELECT COUNT(*) FROM tags WHERE event_id IS NULL');
  if (Number(tNull.rows[0].count) > 0) errors.push('tags with NULL event_id');
  const tBad = await q('SELECT COUNT(*) FROM tags t LEFT JOIN events e ON t.event_id=e.id WHERE e.id IS NULL');
  if (Number(tBad.rows[0].count) > 0) errors.push('tags with invalid event_id');

  // duplicate tags per (event_id, lower(name))
  const dup = await q('SELECT event_id, LOWER(name) AS ln, COUNT(*) FROM tags GROUP BY event_id, LOWER(name) HAVING COUNT(*)>1');
  if (dup.rowCount > 0) errors.push(`duplicate tags found: ${dup.rowCount}`);

  // photo_tags mismatched events
  const ptMismatch = await q(`
    SELECT COUNT(*)
    FROM photo_tags pt
    JOIN photos p ON p.id = pt.photo_id
    JOIN tags t ON t.id = pt.tag_id
    WHERE p.event_id <> t.event_id
  `);
  if (Number(ptMismatch.rows[0].count) > 0) errors.push('photo_tags rows where photo and tag have different event_id');

  // share_links validation
  const slBad = await q(`
    SELECT COUNT(*) FROM share_links s
    JOIN tags t ON t.id = s.tag_id
    WHERE s.event_id <> t.event_id
  `);
  if (Number(slBad.rows[0].count) > 0) errors.push('share_links rows where event_id does not match tag.event_id');

  if (errors.length === 0) {
    console.log('OK');
  } else {
    console.error('FAIL');
    for (const e of errors) console.error('-', e);
    process.exitCode = 1;
  }
  if (warn.length > 0) {
    console.warn('WARN');
    for (const w of warn) console.warn('-', w);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
