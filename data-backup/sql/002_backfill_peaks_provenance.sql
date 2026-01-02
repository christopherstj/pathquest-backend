-- Backfills peaks provenance + seed_coords from existing data.
-- Run with:
--   psql -h 127.0.0.1 -p 5432 -U local-user -d operations -v ON_ERROR_STOP=1 -f pathquest-backend/data-backup/sql/002_backfill_peaks_provenance.sql

BEGIN;

-- source_origin (best-effort, only when missing)
UPDATE peaks
SET source_origin = 'osm'
WHERE source_origin IS NULL
  AND id ~ '^[0-9]+$';

UPDATE peaks
SET source_origin = 'manual'
WHERE source_origin IS NULL
  AND id ~ '^pq[0-9]+$';

-- UUID-like ids: treat as unknown (we should not assume peakbagger unless we have recoverable PB ids)
UPDATE peaks
SET source_origin = 'unknown'
WHERE source_origin IS NULL
  AND id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE peaks
SET source_origin = 'unknown'
WHERE source_origin IS NULL;

-- seed_coords: copy from existing location point (only when missing)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'peaks'
          AND column_name = 'location_geom'
    ) THEN
        EXECUTE $sql$
            UPDATE peaks
            SET seed_coords = location_geom
            WHERE seed_coords IS NULL
              AND location_geom IS NOT NULL
        $sql$;
    ELSE
        EXECUTE $sql$
            UPDATE peaks
            SET seed_coords = (location_coords::geometry)
            WHERE seed_coords IS NULL
              AND location_coords IS NOT NULL
        $sql$;
    END IF;
END $$;

COMMIT;


