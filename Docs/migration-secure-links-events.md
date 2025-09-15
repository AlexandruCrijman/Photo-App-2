# Secure Links + Events Migration Plan (Backfill + Verification)

This document describes how to migrate an existing database to support:
- Events-scoped photos and tags
- Case-insensitive unique tags per event
- Password-protected share links (person view)

Applies to PostgreSQL.

## Summary
- Create `events` and `share_links` tables.
- Add `event_id` to `photos` and `tags` and backfill with a default event for all existing rows.
- Move global tag uniqueness to `(event_id, LOWER(name))` and deduplicate conflicting tags.
- Add `current_event_id` and `person_view_password_hash` columns to `settings`.
- Verify integrity with a verification script.

## Pre-requisites
- Put the app in maintenance mode.
- Take a full database backup.

## One-time SQL Migration (Transactional)
Run inside a single transaction if possible. Adjust names if your schema differs.

```sql
BEGIN;

-- 1) Events table
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure a Default event exists
INSERT INTO events (name)
SELECT 'Default'
WHERE NOT EXISTS (SELECT 1 FROM events WHERE LOWER(name)=LOWER('Default'));

-- 2) Settings columns
ALTER TABLE IF EXISTS settings
  ADD COLUMN IF NOT EXISTS system_prompt TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS current_event_id INT REFERENCES events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS person_view_password_hash TEXT;

-- Set current_event_id to Default if NULL
UPDATE settings
SET current_event_id = (SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1)
WHERE current_event_id IS NULL;

-- 3) Photos: add event_id
ALTER TABLE IF EXISTS photos
  ADD COLUMN IF NOT EXISTS event_id INT REFERENCES events(id) ON DELETE CASCADE;

UPDATE photos
SET event_id = (SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1)
WHERE event_id IS NULL;

-- 4) Tags: add event_id
ALTER TABLE IF EXISTS tags
  ADD COLUMN IF NOT EXISTS event_id INT REFERENCES events(id) ON DELETE CASCADE;

UPDATE tags
SET event_id = (SELECT id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1)
WHERE event_id IS NULL;

-- 5) Drop global tag unique, add event-scoped case-insensitive unique
DO $$
BEGIN
  -- Drop any old unique on tags.name if present
  PERFORM 1 FROM pg_constraint
  WHERE conrelid = 'public.tags'::regclass AND contype = 'u' AND conname LIKE '%tags_name%';
  IF FOUND THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.tags DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'public.tags'::regclass AND contype = 'u' AND conname LIKE '%tags_name%'
      LIMIT 1
    );
  END IF;
END$$;

-- Create new unique index for (event_id, lower(name))
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_event_lower_unique ON tags (event_id, LOWER(name));

COMMIT;
```

## Deduplicate Tags (Case-insensitive within event)
If historic data contains duplicates like "Alex" and "alex" in the same event, merge them.

```sql
-- For each event, keep the earliest tag id per lower(name) and merge the rest
WITH dupe AS (
  SELECT event_id, LOWER(name) AS l, MIN(id) AS keep_id, ARRAY_AGG(id ORDER BY id) AS all_ids
  FROM tags
  GROUP BY event_id, LOWER(name)
), to_merge AS (
  SELECT d.event_id, d.keep_id, unnest(d.all_ids[2:]) AS drop_id
  FROM dupe d
)
-- Re-point photo_tags to keep_id
UPDATE photo_tags pt
SET tag_id = tm.keep_id
FROM to_merge tm
JOIN tags t_keep ON t_keep.id = tm.keep_id
JOIN tags t_drop ON t_drop.id = tm.drop_id
WHERE pt.tag_id = tm.drop_id AND t_keep.event_id = t_drop.event_id;

-- Drop merged tags
DELETE FROM tags t
USING to_merge tm
WHERE t.id = tm.drop_id;
```

Recreate the unique index after dedup if needed.

## Share Links Schema
Ensure these are present:
- `share_links(id, event_id, tag_id, token UNIQUE, created_at, expires_at NULL, revoked BOOLEAN DEFAULT FALSE)`

## Application Config
- Backend CORS: allow credentialed requests from exact origin `FRONTEND_ORIGIN`.
- Frontend: use `credentials: 'include'` on API calls.

## Verification
Checks to perform after migration:
- `settings.current_event_id` exists in `events`.
- All `photos.event_id` and `tags.event_id` are non-null and valid.
- No duplicate tags per `(event_id, LOWER(name))`.
- No `photo_tags` rows where photo and tag are from different events.
- All `share_links` rows point to matching event/tag pairs.

If any check fails, restore from backup or fix and re-run verification.
