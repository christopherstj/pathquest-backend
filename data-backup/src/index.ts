import { config } from "dotenv";
config();
import geocodePeaks from "./geocodePeaks";
import getPeakElevations from "./getPeakElevations";
import getOsmData from "./getOsmData";
import loadOsmData from "./loadOsmData";
import mysqlToPsql from "./mysqlToPsql";
import importChallenge from "./importChallenge";
import test from "./test";
import importPeakbaggerPeaks from "./importPeakbaggerPeaks";
import importClimb13ersPeaks from "./importClimb13ersPeaks";
import import14ersPeaks from "./import14ersPeaks";
import export14ersRankedExternalIds from "./export14ersRankedExternalIds";
import create14ersChallenges from "./create14ersChallenges";
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
import snapPeaksToHighest3dep from "./snapPeaksToHighest3dep";
import computeSummitZones from "./computeSummitZones";

const main = async () => {
    const task = process.env.TASK;
    if (task) {
        switch (task) {
            case "enrich-peaks-public-lands":
                await enrichPeaksWithPublicLands();
                return;
            case "import-peakbagger-peaks":
                await importPeakbaggerPeaks();
                return;
            case "import-climb13ers-peaks":
                await importClimb13ersPeaks();
                return;
            case "import-14ers-peaks":
                await import14ersPeaks();
                return;
            case "export-14ers-ranked":
                await export14ersRankedExternalIds();
                return;
            case "create-14ers-challenges":
                await create14ersChallenges();
                return;
            case "snap-peaks-3dep":
                await snapPeaksToHighest3dep();
                return;
            case "post-snap-enrichment":
                await enrichGeocodingPostGIS();
                await enrichPeaksWithPublicLands();
                return;
            case "compute-summit-zones":
                await computeSummitZones();
                return;
            default:
                console.log(`Unknown TASK: ${task}`);
                console.log(`Known TASK values:`);
                console.log(`  - enrich-peaks-public-lands`);
                console.log(`  - import-peakbagger-peaks`);
                console.log(`  - import-climb13ers-peaks`);
                console.log(`  - import-14ers-peaks`);
                console.log(`  - export-14ers-ranked`);
                console.log(`  - create-14ers-challenges`);
                console.log(`  - snap-peaks-3dep`);
                console.log(`  - post-snap-enrichment`);
                console.log(`  - compute-summit-zones`);
                return;
        }
    }

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
    // await enrichPeaksWithPublicLands();

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
    //   PEAKBAGGER_LIST_ID=21364 npm run dev:once
    //   DRY_RUN=false REVIEW_FILE=review-5061.json npm run dev:once
    // await importChallenge();
};

main().catch((error) => {
    console.error(error);
});
