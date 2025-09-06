import dotenv from 'dotenv';
import pkg from 'pg';

dotenv.config();

const { Pool } = pkg;

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/photo_app';

export const pool = new Pool({ connectionString });

export async function initializeDatabase() {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS photos (
			id SERIAL PRIMARY KEY,
			filename TEXT NOT NULL,
			original_name TEXT,
			mime_type TEXT,
			width INT,
			height INT,
			size_bytes BIGINT,
			created_at TIMESTAMPTZ DEFAULT now()
		);

		CREATE TABLE IF NOT EXISTS tags (
			id SERIAL PRIMARY KEY,
			name TEXT UNIQUE NOT NULL
		);

		CREATE TABLE IF NOT EXISTS photo_tags (
			photo_id INT REFERENCES photos(id) ON DELETE CASCADE,
			tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
			PRIMARY KEY (photo_id, tag_id)
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


