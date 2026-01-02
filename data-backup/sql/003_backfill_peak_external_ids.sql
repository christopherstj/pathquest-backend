-- Backfills peak_external_ids for existing peaks where peaks.id encodes an external identifier.
-- Run with:
--   psql -h 127.0.0.1 -p 5432 -U local-user -d operations -v ON_ERROR_STOP=1 -f pathquest-backend/data-backup/sql/003_backfill_peak_external_ids.sql

BEGIN;

-- OSM: numeric peaks.id
INSERT INTO peak_external_ids (peak_id, source, external_id)
SELECT p.id, 'osm', p.id
FROM peaks p
WHERE p.id ~ '^[0-9]+$'
ON CONFLICT DO NOTHING;

-- Manual: pq{number}
INSERT INTO peak_external_ids (peak_id, source, external_id)
SELECT p.id, 'manual', p.id
FROM peaks p
WHERE p.id ~ '^pq[0-9]+$'
ON CONFLICT DO NOTHING;

COMMIT;


