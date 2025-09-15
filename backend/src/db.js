import dotenv from 'dotenv';
import pkg from 'pg';

dotenv.config();

const { Pool } = pkg;

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/photo_app';

export const pool = new Pool({ connectionString });

export async function initializeDatabase() {
	await pool.query(`
		-- Events: top-level partitioning for photos and tags
		CREATE TABLE IF NOT EXISTS events (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			created_at TIMESTAMPTZ DEFAULT now()
		);
		-- Ensure case-insensitive unique event names
		DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_events_name_lower_unique'
			) THEN
				CREATE UNIQUE INDEX idx_events_name_lower_unique ON events ((LOWER(name)));
			END IF;
		END $$;

		-- Seed default event
		INSERT INTO events (name)
		SELECT 'Default'
		WHERE NOT EXISTS (SELECT 1 FROM events WHERE LOWER(name) = LOWER('Default'));

		CREATE TABLE IF NOT EXISTS photos (
			id SERIAL PRIMARY KEY,
			filename TEXT NOT NULL,
			thumb_filename TEXT,
			preview_filename TEXT,
			original_name TEXT,
			mime_type TEXT,
			width INT,
			height INT,
			size_bytes BIGINT,
			completed BOOLEAN DEFAULT FALSE,
			description TEXT,
			description_model TEXT,
			described_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ DEFAULT now(),
			event_id INT
		);

		ALTER TABLE photos ADD COLUMN IF NOT EXISTS thumb_filename TEXT;
		ALTER TABLE photos ADD COLUMN IF NOT EXISTS preview_filename TEXT;
		ALTER TABLE photos ADD COLUMN IF NOT EXISTS width INT;
		ALTER TABLE photos ADD COLUMN IF NOT EXISTS height INT;
		ALTER TABLE photos ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT FALSE;
		ALTER TABLE photos ADD COLUMN IF NOT EXISTS description TEXT;
		ALTER TABLE photos ADD COLUMN IF NOT EXISTS description_model TEXT;
		ALTER TABLE photos ADD COLUMN IF NOT EXISTS described_at TIMESTAMPTZ;

		CREATE TABLE IF NOT EXISTS tags (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			event_id INT
		);

		-- Drop old global unique index if present, we'll scope by event below
		DO $$ BEGIN
			IF EXISTS (
				SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_tags_name_lower_unique'
			) THEN
				DROP INDEX idx_tags_name_lower_unique;
			END IF;
		END $$;

		CREATE TABLE IF NOT EXISTS photo_tags (
			photo_id INT REFERENCES photos(id) ON DELETE CASCADE,
			tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
			PRIMARY KEY (photo_id, tag_id)
		);

		CREATE TABLE IF NOT EXISTS settings (
			id INT PRIMARY KEY DEFAULT 1,
			system_prompt TEXT,
			model TEXT,
			updated_at TIMESTAMPTZ DEFAULT now(),
			current_event_id INT
		);
		INSERT INTO settings (id) VALUES (1)
		ON CONFLICT (id) DO NOTHING;

		-- Ensure current_event_id exists and points to Default
		DO $$ DECLARE def_id INT; BEGIN
			SELECT id INTO def_id FROM events WHERE LOWER(name)=LOWER('Default') LIMIT 1;
			ALTER TABLE settings ADD COLUMN IF NOT EXISTS current_event_id INT;
			UPDATE settings SET current_event_id = def_id WHERE id = 1 AND current_event_id IS NULL;
			IF NOT EXISTS (
				SELECT 1 FROM information_schema.table_constraints WHERE table_name = 'settings' AND constraint_name = 'settings_event_fk'
			) THEN
				ALTER TABLE settings ADD CONSTRAINT settings_event_fk FOREIGN KEY (current_event_id) REFERENCES events(id) ON DELETE SET NULL;
			END IF;
		END $$;

		-- Backfill and constrain event_id columns
		-- Fetch default event id into a psql variable via DO block
		DO $$ DECLARE def_id INT; BEGIN
			SELECT id INTO def_id FROM events WHERE LOWER(name) = LOWER('Default') LIMIT 1;
			-- Photos
			ALTER TABLE photos ADD COLUMN IF NOT EXISTS event_id INT;
			UPDATE photos SET event_id = def_id WHERE event_id IS NULL;
			-- Add FK if not exists
			IF NOT EXISTS (
				SELECT 1 FROM information_schema.table_constraints WHERE table_name = 'photos' AND constraint_name = 'photos_event_fk'
			) THEN
				ALTER TABLE photos ADD CONSTRAINT photos_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
			END IF;
			-- Set NOT NULL
			ALTER TABLE photos ALTER COLUMN event_id SET NOT NULL;

			-- Tags
			ALTER TABLE tags ADD COLUMN IF NOT EXISTS event_id INT;
			UPDATE tags SET event_id = def_id WHERE event_id IS NULL;
			-- Drop any legacy global unique constraint on tags.name
			EXECUTE 'ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_name_key';
			IF NOT EXISTS (
				SELECT 1 FROM information_schema.table_constraints WHERE table_name = 'tags' AND constraint_name = 'tags_event_fk'
			) THEN
				ALTER TABLE tags ADD CONSTRAINT tags_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
			END IF;
			ALTER TABLE tags ALTER COLUMN event_id SET NOT NULL;
		END $$;

		-- Ensure case-insensitive uniqueness of tag names per event
		DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_tags_event_name_lower_unique'
			) THEN
				CREATE UNIQUE INDEX idx_tags_event_name_lower_unique ON tags (event_id, (LOWER(name)));
			END IF;
		END $$;

		-- Share links for person view
		CREATE TABLE IF NOT EXISTS share_links (
			id SERIAL PRIMARY KEY,
			event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
			tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
			token TEXT UNIQUE NOT NULL,
			created_at TIMESTAMPTZ DEFAULT now(),
			expires_at TIMESTAMPTZ NULL,
			revoked BOOLEAN DEFAULT FALSE
		);

		-- Optional: ensure at most one active link per (event, tag)
		DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_share_links_active_unique'
			) THEN
				CREATE UNIQUE INDEX idx_share_links_active_unique ON share_links (event_id, tag_id) WHERE (revoked = FALSE);
			END IF;
		END $$;

		-- Add person view password to settings if missing
		ALTER TABLE settings ADD COLUMN IF NOT EXISTS person_view_password_hash TEXT;

		-- Faces detected per photo
		CREATE TABLE IF NOT EXISTS faces (
			id SERIAL PRIMARY KEY,
			photo_id INT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
			bbox JSONB NOT NULL, -- {left, top, width, height}
			landmarks JSONB,     -- optional 5-point
			yaw REAL,
			pitch REAL,
			roll REAL,
			face_embedding REAL[],       -- length 512
			appearance_embedding REAL[], -- length 256
			fused_embedding REAL[],
			recognized_tag_id INT NULL REFERENCES tags(id) ON DELETE SET NULL,
			face_score REAL,
			fused_score REAL,
			created_at TIMESTAMPTZ DEFAULT now()
		);

		-- Per-tag gallery embeddings (event-scoped via tag->event FK)
		CREATE TABLE IF NOT EXISTS person_embeddings (
			id SERIAL PRIMARY KEY,
			tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
			embedding REAL[] NOT NULL,
			source_face_id INT REFERENCES faces(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ DEFAULT now()
		);
	`);
}

export async function getPhotoWithTags(photoId) {
	const { rows } = await pool.query(
		`SELECT p.*, COALESCE(json_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL), '[]') AS tags
		 FROM photos p
		 LEFT JOIN photo_tags pt ON pt.photo_id = p.id
		 LEFT JOIN tags t ON t.id = pt.tag_id
		 WHERE p.id = $1
		 GROUP BY p.id`,
		[photoId]
	);
	return rows[0];
}

export async function listPhotosWithTags() {
	const { rows } = await pool.query(`
		SELECT p.*, COALESCE(json_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL), '[]') AS tags
		FROM photos p
		LEFT JOIN photo_tags pt ON pt.photo_id = p.id
		LEFT JOIN tags t ON t.id = pt.tag_id
		GROUP BY p.id
		ORDER BY p.id DESC
	`);
	return rows;
}

export async function listPhotosWithTagsPaginated(limit, cursorId) {
	const params = [];
	let where = '';
	if (cursorId) {
		params.push(cursorId);
		where = `WHERE p.id < $${params.length}`;
	}
	params.push(limit);
	const { rows } = await pool.query(
		`
		SELECT p.*, COALESCE(json_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL), '[]') AS tags
		FROM photos p
		LEFT JOIN photo_tags pt ON pt.photo_id = p.id
		LEFT JOIN tags t ON t.id = pt.tag_id
		${where}
		GROUP BY p.id
		ORDER BY p.id DESC
		LIMIT $${params.length}
		`,
		params
	);
	const nextCursor = rows.length > 0 ? rows[rows.length - 1].id : null;
	return { items: rows, nextCursor };
}

export async function listAllTagsWithCounts() {
	const { rows } = await pool.query(`
		SELECT t.name, COUNT(pt.photo_id) AS count
		FROM tags t
		LEFT JOIN photo_tags pt ON pt.tag_id = t.id
		GROUP BY t.id
		ORDER BY t.name ASC
	`);
	return rows;
}


