-- Adds peak provenance + snapping columns, and creates a future-proof external ID junction table.
-- Run with:
--   psql -h 127.0.0.1 -p 5432 -U local-user -d operations -v ON_ERROR_STOP=1 -f pathquest-backend/data-backup/sql/001_peaks_provenance_and_external_ids.sql

BEGIN;

-- =========================================
-- peaks: provenance + snapping/audit columns
-- =========================================

ALTER TABLE peaks
    ADD COLUMN IF NOT EXISTS source_origin TEXT;

ALTER TABLE peaks
    ADD COLUMN IF NOT EXISTS seed_coords geometry(Point, 4326);

ALTER TABLE peaks
    ADD COLUMN IF NOT EXISTS snapped_coords geometry(Point, 4326);

ALTER TABLE peaks
    ADD COLUMN IF NOT EXISTS snapped_distance_m DOUBLE PRECISION;

ALTER TABLE peaks
    ADD COLUMN IF NOT EXISTS snapped_dem_source TEXT;

ALTER TABLE peaks
    ADD COLUMN IF NOT EXISTS coords_snapped_at TIMESTAMP;

ALTER TABLE peaks
    ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;

-- ==================================================
-- peak_external_ids: multiple external IDs per peak
-- ==================================================

CREATE TABLE IF NOT EXISTS peak_external_ids (
    peak_id VARCHAR NOT NULL REFERENCES peaks(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (peak_id, source),
    UNIQUE (source, external_id)
);

COMMIT;


