-- Summit Zone columns for peaks table
-- These columns store polygons representing the summit area within a vertical threshold
-- of the true summit elevation, enabling more accurate summit detection for flat-topped peaks.
--
-- Run this BEFORE using TASK=compute-summit-zones with ZONE_DRY_RUN=false

-- Add summit zone geometry column (can be Polygon or MultiPolygon)
ALTER TABLE peaks ADD COLUMN IF NOT EXISTS summit_zone_geom GEOMETRY(Geometry, 4326);

-- Add the vertical threshold used to compute the zone (for reference/reproducibility)
ALTER TABLE peaks ADD COLUMN IF NOT EXISTS summit_zone_threshold_m NUMERIC;

-- Create spatial index for efficient queries
CREATE INDEX IF NOT EXISTS idx_peaks_summit_zone_geom ON peaks USING GIST (summit_zone_geom);

-- Optional: Add a column to track when the zone was computed
ALTER TABLE peaks ADD COLUMN IF NOT EXISTS summit_zone_computed_at TIMESTAMP WITH TIME ZONE;

