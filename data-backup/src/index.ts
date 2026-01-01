import { config } from "dotenv";
config();
import geocodePeaks from "./geocodePeaks";
import getPeakElevations from "./getPeakElevations";
import getOsmData from "./getOsmData";
import loadOsmData from "./loadOsmData";
import mysqlToPsql from "./mysqlToPsql";
import importChallenge from "./importChallenge";
import test from "./test";
// API-based enrichment (slow, uses external APIs)
import enrichGeocoding from "./enrichGeocoding";
import enrichElevationUS from "./enrichElevationUS";
import enrichElevationGlobal from "./enrichElevationGlobal";
// PostGIS-based enrichment (fast, uses local shapefiles)
import importAdminBoundaries from "./importAdminBoundaries";
import enrichGeocodingPostGIS from "./enrichGeocodingPostGIS";
import importPublicLands from "./importPublicLands";
import enrichPeaksWithPublicLands from "./enrichPeaksWithPublicLands";
import fixInvalidGeometries from "./fixInvalidGeometries";

const main = async () => {
    // === DATA IMPORT TOOLS (Legacy) ===
    // await getPeakElevations();
    // await geocodePeaks();
    // await getOsmData();
    // await loadOsmData();
    // await mysqlToPsql();
    // await test();

    // ============================================================
    // === POSTGIS-BASED GEOCODING (RECOMMENDED - MUCH FASTER) ===
    // ============================================================
    // 
    // Step 1: Download and import admin boundary shapefiles (DONE)
    //   - Natural Earth countries (10m resolution)
    //   - Natural Earth states/provinces (10m resolution)
    //   - US Census counties (500k resolution)
    // await importAdminBoundaries();
    //
    // Step 2: Run spatial joins to geocode all peaks (DONE)
    //   Processes 600k+ peaks in minutes (vs months with API)
    // await enrichGeocodingPostGIS();
    //
    // Step 3: Public lands already imported via GCE VM + ogr2ogr (DONE)
    //   ~200k features from PAD-US Fee layer
    // await importPublicLands();
    //
    // Step 3.5: Fix invalid geometries (DONE - all fixed)
    // await fixInvalidGeometries();
    //
    // Step 4: Tag peaks with public land info
    await enrichPeaksWithPublicLands();

    // ============================================================
    // === API-BASED ENRICHMENT (SLOW - USE FOR EDGE CASES) ===
    // ============================================================
    //
    // Geocoding (Mapbox) - fills country/state/county via API
    //   Requires: MAPBOX_API_KEY env var
    //   Optional: GEOCODING_LIMIT=100000 (default) for monthly quota
    //   Rate: ~10 req/sec (500k peaks = ~14 hours)
    // await enrichGeocoding();
    //
    // US Elevation (USGS 3DEP) - highest quality elevation for US peaks
    //   Overwrites existing elevation with USGS data
    //   Rate: ~10 req/sec
    // await enrichElevationUS();
    //
    // Global Elevation (Open-Meteo/SRTM) - fills missing elevation
    //   Only fills peaks with elevation IS NULL
    //   Rate: ~500/sec (batched requests)
    // await enrichElevationGlobal();

    // === CHALLENGE IMPORT PIPELINE ===
    // Use environment variables to control behavior:
    //   PEAKBAGGER_LIST_ID=5061    - Scrape from Peakbagger list
    //   PEAKS_JSON_FILE=peaks.json - Load peaks from JSON file
    //   REVIEW_FILE=review.json    - Import reviewed matches
    //   DRY_RUN=false              - Actually insert (default: true)
    //   INCLUDE_LOW_CONFIDENCE=true - Include low confidence matches
    //
    // Example usage:
    //   PEAKBAGGER_LIST_ID=5061 npm run dev:once
    //   DRY_RUN=false REVIEW_FILE=review-5061.json npm run dev:once
    // await importChallenge();
};

main().catch((error) => {
    console.error(error);
});
