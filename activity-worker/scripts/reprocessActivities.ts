import { config } from "dotenv";
config(); // Load environment variables from .env file

import * as fs from "fs";
import * as path from "path";
import processCoords from "../helpers/processCoords";
import getCloudSqlConnection from "../helpers/getCloudSqlConnection";
import saveActivitySummits from "../helpers/saveActivitySummits";
import getHistoricalWeatherByCoords from "../helpers/getHistoricalWeatherByCoords";

/**
 * Reprocesses all activities in the database with the new confidence-based summit detection.
 * 
 * This script:
 * 1. Reads activities from the database (coords, time_stream, vert_profile)
 * 2. Deletes existing summits for each activity
 * 3. Reprocesses using the new confidence scoring algorithm
 * 4. Saves new summits with confidence scores
 * 
 * Usage:
 *   npm run reprocess:activities
 * 
 * Environment variables:
 *   BATCH_SIZE - Number of activities to fetch per batch (default: 100)
 *   CONCURRENCY - Number of activities to process in parallel (default: 10)
 *   LIMIT - Maximum number of activities to process (default: all)
 *   START_FROM_ID - Start processing from this activity ID (optional)
 *   ACTIVITY_IDS_FILE - Path to JSON file containing array of activity IDs to process (optional)
 *                       Example: ACTIVITY_IDS_FILE=activities_to_reprocess.json
 *   WEATHER_DELAY_MS - Delay in milliseconds between weather API calls (default: 200ms)
 *                      Increase this if you're hitting rate limits
 */

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "100", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "10", 10);
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;
const START_FROM_ID = process.env.START_FROM_ID;
const ACTIVITY_IDS_FILE = process.env.ACTIVITY_IDS_FILE;
const WEATHER_DELAY_MS = parseInt(process.env.WEATHER_DELAY_MS ?? "200", 10); // Delay between weather API calls in milliseconds
const VERBOSE = process.env.VERBOSE !== "false"; // Default true - detailed per-activity logging

// Geographic bounding box filter (optional)
// Format: "min_lon,min_lat,max_lon,max_lat"
// Colorado example: "-109.05,36.99,-102.04,41.00"
const BBOX = process.env.REPROCESS_BBOX ?? "";
const STATE_FILTER = process.env.REPROCESS_STATE ?? ""; // e.g., "CO" - filters by activity start coords intersecting peaks in that state

// =========================================================================
// PROGRESS TRACKING HELPERS
// =========================================================================

const formatDuration = (seconds: number): string => {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
};

const formatMemory = (): string => {
    const used = process.memoryUsage();
    const heapMB = (used.heapUsed / 1024 / 1024).toFixed(1);
    const rssMB = (used.rss / 1024 / 1024).toFixed(1);
    return `Heap: ${heapMB}MB | RSS: ${rssMB}MB`;
};

const getTimestamp = (): string => {
    return new Date().toISOString().slice(11, 19); // HH:MM:SS
};

class ProgressTracker {
    private startTime: number;
    private processed: number = 0;
    private summits: number = 0;
    private errors: number = 0;
    private total: number;

    constructor(total: number) {
        this.startTime = Date.now();
        this.total = total;
    }

    update(processed: number, summits: number, errors: number) {
        this.processed += processed;
        this.summits += summits;
        this.errors += errors;
    }

    getStats() {
        const elapsedSec = (Date.now() - this.startTime) / 1000;
        const rate = this.processed / elapsedSec;
        const remaining = this.total - this.processed;
        const etaSec = rate > 0 ? remaining / rate : 0;
        const pct = this.total > 0 ? (this.processed / this.total) * 100 : 0;

        return {
            processed: this.processed,
            summits: this.summits,
            errors: this.errors,
            total: this.total,
            elapsedSec,
            rate,
            etaSec,
            pct,
        };
    }

    printSummary() {
        const s = this.getStats();
        console.log(`\n${"═".repeat(70)}`);
        console.log(`📊 PROGRESS: ${s.processed}/${s.total} (${s.pct.toFixed(1)}%)`);
        console.log(`   ⏱️  Elapsed: ${formatDuration(s.elapsedSec)} | ETA: ${formatDuration(s.etaSec)}`);
        console.log(`   📈 Rate: ${s.rate.toFixed(2)} activities/sec | ${(s.rate * 60).toFixed(1)} activities/min`);
        console.log(`   🏔️  Summits: ${s.summits} | ❌ Errors: ${s.errors}`);
        console.log(`   💾 ${formatMemory()}`);
        console.log(`${"═".repeat(70)}`);
    }
}

// Load activity IDs from file if specified
let activityIdsToProcess: string[] | undefined = undefined;
if (ACTIVITY_IDS_FILE) {
    try {
        const filePath = path.isAbsolute(ACTIVITY_IDS_FILE)
            ? ACTIVITY_IDS_FILE
            : path.join(__dirname, "..", ACTIVITY_IDS_FILE);
        const fileContent = fs.readFileSync(filePath, "utf-8");
        activityIdsToProcess = JSON.parse(fileContent);
        if (!Array.isArray(activityIdsToProcess)) {
            throw new Error("Activity IDs file must contain a JSON array");
        }
        console.log(`Loaded ${activityIdsToProcess.length} activity IDs from ${ACTIVITY_IDS_FILE}`);
    } catch (error) {
        console.error(`Error loading activity IDs file: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

// Blocklist of activity types that are not human-powered
const EXCLUDED_SPORT_TYPES = [
    'AlpineSki',      // Lift-assisted downhill skiing
    'Snowboard',      // Lift-assisted downhill
    'Sail',           // Wind-powered
    'Windsurf',       // Wind-powered
    'Kitesurf',       // Wind-powered
    'VirtualRide',    // Indoor/simulated - no real summits
    'VirtualRun',     // Indoor/simulated - no real summits
    'Golf',           // Not relevant to peak bagging
    'Velomobile',     // Often aerodynamically assisted
];

interface ActivityRow {
    id: string;
    user_id: string;
    coords: string; // GeoJSON string
    time_stream: number[] | null;
    vert_profile: number[] | null; // altitude data
    start_time: Date;
    is_public: boolean;
    activity_json: any; // Contains utc_offset
}

/**
 * Process a single activity
 */
const processActivity = async (
    activity: ActivityRow,
    pool: any
): Promise<{ summits: number; success: boolean; error?: string }> => {
    try {
        // Check if activity type is excluded
        const sportType = activity.activity_json?.sport_type;
        if (sportType && EXCLUDED_SPORT_TYPES.includes(sportType)) {
            // Delete existing summits for excluded activities (cleanup)
            await pool.query(`DELETE FROM activities_peaks WHERE activity_id = $1`, [
                activity.id,
            ]);
            return { summits: 0, success: true };
        }

        // Parse coordinates from GeoJSON
        const geo = JSON.parse(activity.coords);
        const coords = geo.coordinates as [number, number][];

        if (!coords || coords.length === 0) {
            return { summits: 0, success: true };
        }

        // Parse time stream
        const times: number[] | undefined = Array.isArray(activity.time_stream)
            ? activity.time_stream
            : undefined;

        // Parse altitude stream (vert_profile)
        const altitudes: number[] | undefined = Array.isArray(activity.vert_profile)
            ? activity.vert_profile
            : undefined;

        // Extract utc_offset from activity_json
        const utcOffsetSeconds = activity.activity_json?.utc_offset ?? 0;

        // Delete existing summits for this activity
        await pool.query(`DELETE FROM activities_peaks WHERE activity_id = $1`, [
            activity.id,
        ]);

        // Reprocess with new confidence scoring
        const summits = await processCoords(coords, times, altitudes);

        if (summits.length === 0) {
            return { summits: 0, success: true };
        }

        // Fetch weather data and prepare summit details
        // Process weather requests sequentially with delays to avoid rate limiting
        const startTime = new Date(activity.start_time).getTime();
        const peakDetails: Array<{
            peakId: string;
            timestamp: Date;
            activityId: number;
            weather: any;
            confidenceScore: number;
            needsConfirmation: boolean;
        }> = [];

        for (let i = 0; i < summits.length; i++) {
            const summit = summits[i];
            
            // Add delay between weather API calls (except for the first one)
            if (i > 0) {
                await new Promise((resolve) => setTimeout(resolve, WEATHER_DELAY_MS));
            }

            const timestamp =
                times && times[summit.index] !== undefined
                    ? new Date(startTime + times[summit.index] * 1000)
                    : new Date(activity.start_time);

            const weather = await getHistoricalWeatherByCoords(
                timestamp,
                { lat: summit.lat, lon: summit.lng },
                summit.elevation ?? 0
            );

            peakDetails.push({
                peakId: summit.id,
                timestamp,
                activityId: parseInt(activity.id, 10),
                weather,
                confidenceScore: summit.confidenceScore,
                needsConfirmation: summit.needsConfirmation,
            });
        }

        // Save new summits with confidence scores
        await saveActivitySummits(
            peakDetails,
            activity.id,
            activity.is_public,
            utcOffsetSeconds
        );

        return { summits: summits.length, success: true };
    } catch (error) {
        return {
            summits: 0,
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
};

/**
 * Process activities with concurrency control
 */
const processBatch = async (
    activities: ActivityRow[],
    pool: any,
    batchNum: number,
    totalBatches: number
): Promise<{ processed: number; summits: number; errors: number }> => {
    let processed = 0;
    let totalSummits = 0;
    let errors = 0;
    const batchStartTime = Date.now();

    // Process activities in parallel with concurrency limit
    for (let i = 0; i < activities.length; i += CONCURRENCY) {
        const chunk = activities.slice(i, i + CONCURRENCY);
        const chunkStartTime = Date.now();

        const results = await Promise.allSettled(
            chunk.map((activity) => processActivity(activity, pool))
        );

        const chunkElapsed = ((Date.now() - chunkStartTime) / 1000).toFixed(2);

        // Process results
        results.forEach((result, idx) => {
            const activity = chunk[idx];
            if (result.status === "fulfilled") {
                const { summits, success, error } = result.value;
                if (success) {
                    processed++;
                    totalSummits += summits;
                    if (VERBOSE && summits > 0) {
                        console.log(
                            `  [${getTimestamp()}] ✅ ${activity.id} → ${summits} summit(s)`
                        );
                    }
                } else {
                    errors++;
                    console.error(
                        `  [${getTimestamp()}] ❌ ${activity.id} → Error: ${error}`
                    );
                }
            } else {
                errors++;
                console.error(
                    `  [${getTimestamp()}] 💥 ${activity.id} → Fatal: ${result.reason}`
                );
            }
        });

        // Progress update for this chunk
        const chunkProgress = ((i + chunk.length) / activities.length * 100).toFixed(0);
        const batchElapsed = ((Date.now() - batchStartTime) / 1000).toFixed(1);
        console.log(
            `  [${getTimestamp()}] Batch ${batchNum}/${totalBatches} │ ${i + chunk.length}/${activities.length} (${chunkProgress}%) │ ${chunkElapsed}s/chunk │ ${batchElapsed}s total`
        );
    }

    return { processed, summits: totalSummits, errors };
};

const main = async () => {
    const pool = await getCloudSqlConnection();

    console.log(`\n${"═".repeat(70)}`);
    console.log(`🏔️  PATHQUEST ACTIVITY REPROCESSOR`);
    console.log(`${"═".repeat(70)}`);
    console.log(`   Started at: ${new Date().toISOString()}`);
    console.log(`   📦 Batch size: ${BATCH_SIZE}`);
    console.log(`   🔄 Concurrency: ${CONCURRENCY} parallel`);
    console.log(`   🌤️  Weather delay: ${WEATHER_DELAY_MS}ms`);
    console.log(`   📝 Verbose logging: ${VERBOSE ? "ON" : "OFF"}`);
    if (LIMIT) console.log(`   🎯 Limit: ${LIMIT} activities`);
    if (START_FROM_ID) console.log(`   ⏭️  Start from ID: ${START_FROM_ID}`);
    if (activityIdsToProcess) console.log(`   📋 Specific IDs: ${activityIdsToProcess.length} activities`);
    if (BBOX) console.log(`   🗺️  Bounding box: ${BBOX}`);
    if (STATE_FILTER) console.log(`   📍 State filter: ${STATE_FILTER}`);
    console.log(`${"═".repeat(70)}\n`);

    // Build query
    let query = `
        SELECT 
            id,
            user_id,
            ST_AsGeoJSON(coords::geometry) as coords,
            time_stream,
            vert_profile,
            start_time,
            is_public,
            activity_json
        FROM activities
        WHERE coords IS NOT NULL
    `;

    const queryParams: any[] = [];
    let paramIndex = 1;

    // If specific activity IDs are provided, filter by those
    if (activityIdsToProcess && activityIdsToProcess.length > 0) {
        query += ` AND id = ANY($${paramIndex}::text[])`;
        queryParams.push(activityIdsToProcess);
        paramIndex++;
    } else if (START_FROM_ID) {
        query += ` AND id >= $${paramIndex}`;
        queryParams.push(START_FROM_ID);
        paramIndex++;
    }

    // Geographic bounding box filter
    if (BBOX) {
        const [minLon, minLat, maxLon, maxLat] = BBOX.split(",").map(Number);
        if (!isNaN(minLon) && !isNaN(minLat) && !isNaN(maxLon) && !isNaN(maxLat)) {
            query += ` AND ST_Intersects(
                coords::geometry,
                ST_MakeEnvelope($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, 4326)
            )`;
            queryParams.push(minLon, minLat, maxLon, maxLat);
            paramIndex += 4;
        } else {
            console.error("Invalid BBOX format. Expected: min_lon,min_lat,max_lon,max_lat");
            process.exit(1);
        }
    }

    // State filter - uses start_coords to check if activity starts in a state
    if (STATE_FILTER && !BBOX) {
        query += ` AND EXISTS (
            SELECT 1 FROM peaks p
            WHERE p.state = $${paramIndex}
              AND ST_DWithin(start_coords, p.location_coords, 100000)
        )`;
        queryParams.push(STATE_FILTER);
        paramIndex++;
    }

    // NOTE: ORDER BY is added per-query below, not here (for pagination to work)

    // For specific activity IDs, we can load them all (limited set)
    // Otherwise, use cursor-based pagination to avoid OOM
    if (activityIdsToProcess && activityIdsToProcess.length > 0) {
        const { rows: allActivities } = await pool.query<ActivityRow>(query + ` ORDER BY id ASC`, queryParams);
        console.log(`Found ${allActivities.length} activities to process\n`);
        
        let totalProcessed = 0;
        let totalSummits = 0;
        let totalErrors = 0;
        const totalBatches = Math.ceil(allActivities.length / BATCH_SIZE);

        for (let i = 0; i < allActivities.length; i += BATCH_SIZE) {
            const batch = allActivities.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;

            console.log(
                `\n${"=".repeat(60)}\nProcessing batch ${batchNum}/${totalBatches} (activities ${i + 1}-${Math.min(i + BATCH_SIZE, allActivities.length)})\n${"=".repeat(60)}`
            );

            const startTime = Date.now();
            const result = await processBatch(batch, pool, batchNum, totalBatches);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            totalProcessed += result.processed;
            totalSummits += result.summits;
            totalErrors += result.errors;

            const overallProgress = ((i + batch.length) / allActivities.length * 100).toFixed(1);
            console.log(
                `\nBatch ${batchNum} complete in ${elapsed}s - Overall: ${i + batch.length}/${allActivities.length} (${overallProgress}%)`
            );
            console.log(
                `  Total summits: ${totalSummits} | Total errors: ${totalErrors} | Processed: ${totalProcessed}`
            );
        }

        console.log("\n" + "=".repeat(60));
        console.log("Reprocessing complete!");
        console.log(`Total activities processed: ${totalProcessed}`);
        console.log(`Total summits detected: ${totalSummits}`);
        console.log(`Total errors: ${totalErrors}`);
        console.log("=".repeat(60));

        await pool.end();
        process.exit(0);
    }

    // =========================================================================
    // CURSOR-BASED PAGINATION - fetch one batch at a time to avoid OOM
    // =========================================================================
    
    // First, get total count for progress reporting
    console.log(`\n[${getTimestamp()}] 🔍 Counting activities matching criteria...`);
    
    // Build count query with same WHERE conditions (but without SELECT columns)
    let countQuery = `SELECT COUNT(*) as count FROM activities WHERE coords IS NOT NULL`;
    const countParams: any[] = [];
    let countParamIndex = 1;
    
    if (START_FROM_ID) {
        countQuery += ` AND id >= $${countParamIndex}`;
        countParams.push(START_FROM_ID);
        countParamIndex++;
    }
    
    if (BBOX) {
        const [minLon, minLat, maxLon, maxLat] = BBOX.split(",").map(Number);
        countQuery += ` AND ST_Intersects(coords::geometry, ST_MakeEnvelope($${countParamIndex}, $${countParamIndex + 1}, $${countParamIndex + 2}, $${countParamIndex + 3}, 4326))`;
        countParams.push(minLon, minLat, maxLon, maxLat);
        countParamIndex += 4;
    }
    
    if (STATE_FILTER && !BBOX) {
        countQuery += ` AND EXISTS (SELECT 1 FROM peaks p WHERE p.state = $${countParamIndex} AND ST_DWithin(start_coords, p.location_coords, 100000))`;
        countParams.push(STATE_FILTER);
        countParamIndex++;
    }
    
    const { rows: countRows } = await pool.query<{ count: string }>(countQuery, countParams);
    const totalCount = parseInt(countRows[0]?.count ?? "0", 10);
    
    const effectiveLimit = LIMIT ? Math.min(LIMIT, totalCount) : totalCount;
    
    console.log(`\n${"═".repeat(70)}`);
    console.log(`🚀 ACTIVITY REPROCESSING - STARTING`);
    console.log(`${"═".repeat(70)}`);
    console.log(`   📊 Total matching activities: ${totalCount.toLocaleString()}`);
    if (LIMIT) console.log(`   🎯 Processing limit: ${LIMIT.toLocaleString()}`);
    console.log(`   📦 Batch size: ${BATCH_SIZE} | Concurrency: ${CONCURRENCY}`);
    console.log(`   🌤️  Weather API delay: ${WEATHER_DELAY_MS}ms`);
    console.log(`   💾 ${formatMemory()}`);
    console.log(`${"═".repeat(70)}\n`);

    if (effectiveLimit === 0) {
        console.log("No activities to process. Exiting.");
        await pool.end();
        process.exit(0);
    }

    const progress = new ProgressTracker(effectiveLimit);
    let lastId: string | null = null;
    let batchNum = 0;
    const estimatedBatches = Math.ceil(effectiveLimit / BATCH_SIZE);

    while (progress.getStats().processed < effectiveLimit) {
        batchNum++;
        
        // Build paginated query - use id > lastId for cursor pagination
        let paginatedQuery = query;
        const paginatedParams = [...queryParams];
        
        if (lastId) {
            paginatedQuery += ` AND id > $${paginatedParams.length + 1}`;
            paginatedParams.push(lastId);
        }
        
        // Add ORDER BY after WHERE conditions, then LIMIT
        paginatedQuery += ` ORDER BY id ASC LIMIT $${paginatedParams.length + 1}`;
        paginatedParams.push(BATCH_SIZE);

        console.log(`\n[${getTimestamp()}] 📦 Fetching batch ${batchNum}/${estimatedBatches}...`);
        const fetchStart = Date.now();
        const { rows: batch } = await pool.query<ActivityRow>(paginatedQuery, paginatedParams);
        const fetchTime = ((Date.now() - fetchStart) / 1000).toFixed(2);
        
        if (batch.length === 0) {
            console.log(`[${getTimestamp()}] ✅ No more activities to process.`);
            break;
        }

        // Update cursor for next batch
        lastId = batch[batch.length - 1].id;

        console.log(`[${getTimestamp()}] 📦 Batch ${batchNum}/${estimatedBatches} │ ${batch.length} activities │ Fetched in ${fetchTime}s`);
        console.log(`${"─".repeat(70)}`);

        const batchStart = Date.now();
        const result = await processBatch(batch, pool, batchNum, estimatedBatches);
        const batchElapsed = (Date.now() - batchStart) / 1000;

        progress.update(result.processed, result.summits, result.errors);

        // Show progress summary after each batch
        progress.printSummary();

        // Check if we've hit the limit
        if (LIMIT && progress.getStats().processed >= LIMIT) {
            console.log(`\n[${getTimestamp()}] 🎯 Reached LIMIT of ${LIMIT} activities.`);
            break;
        }
    }

    // Final summary
    const stats = progress.getStats();
    console.log(`\n${"═".repeat(70)}`);
    console.log(`🏁 REPROCESSING COMPLETE`);
    console.log(`${"═".repeat(70)}`);
    console.log(`   📊 Activities processed: ${stats.processed.toLocaleString()}`);
    console.log(`   🏔️  Summits detected: ${stats.summits.toLocaleString()}`);
    console.log(`   ❌ Errors: ${stats.errors}`);
    console.log(`   ⏱️  Total time: ${formatDuration(stats.elapsedSec)}`);
    console.log(`   📈 Average rate: ${stats.rate.toFixed(2)} activities/sec`);
    console.log(`   💾 Final ${formatMemory()}`);
    console.log(`${"═".repeat(70)}`);

    await pool.end();
    process.exit(0);
};

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
