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

    // Process activities in parallel with concurrency limit
    for (let i = 0; i < activities.length; i += CONCURRENCY) {
        const chunk = activities.slice(i, i + CONCURRENCY);
        const startIdx = i + 1;
        const endIdx = Math.min(i + CONCURRENCY, activities.length);

        const results = await Promise.allSettled(
            chunk.map((activity) => processActivity(activity, pool))
        );

        // Process results
        results.forEach((result, idx) => {
            const activity = chunk[idx];
            if (result.status === "fulfilled") {
                const { summits, success, error } = result.value;
                if (success) {
                    processed++;
                    totalSummits += summits;
                    if (summits > 0) {
                        console.log(
                            `  [${startIdx + idx}] Activity ${activity.id}: ${summits} summit(s) detected`
                        );
                    }
                } else {
                    errors++;
                    console.error(
                        `  [${startIdx + idx}] Activity ${activity.id}: Error - ${error}`
                    );
                }
            } else {
                errors++;
                console.error(
                    `  [${startIdx + idx}] Activity ${activity.id}: Fatal error - ${result.reason}`
                );
            }
        });

        // Progress update for this chunk
        const chunkProgress = ((i + chunk.length) / activities.length * 100).toFixed(1);
        console.log(
            `  Batch ${batchNum}/${totalBatches} - Chunk progress: ${i + chunk.length}/${activities.length} (${chunkProgress}%)`
        );
    }

    return { processed, summits: totalSummits, errors };
};

const main = async () => {
    const pool = await getCloudSqlConnection();

    console.log("Starting activity reprocessing with confidence-based summit detection...");
    console.log(`Batch size: ${BATCH_SIZE}`);
    console.log(`Concurrency: ${CONCURRENCY} activities in parallel`);
    console.log(`Weather API delay: ${WEATHER_DELAY_MS}ms between requests`);
    if (LIMIT) console.log(`Limit: ${LIMIT} activities`);
    if (START_FROM_ID) console.log(`Starting from activity ID: ${START_FROM_ID}`);
    if (activityIdsToProcess) console.log(`Processing specific activity IDs: ${activityIdsToProcess.length} activities`);

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

    query += ` ORDER BY id ASC`;

    if (LIMIT && !activityIdsToProcess) {
        // Only apply LIMIT if not processing specific IDs
        query += ` LIMIT $${paramIndex}`;
        queryParams.push(LIMIT);
    }

    const { rows: allActivities } = await pool.query<ActivityRow>(query, queryParams);

    console.log(`Found ${allActivities.length} activities to process\n`);

    let totalProcessed = 0;
    let totalSummits = 0;
    let totalErrors = 0;

    const totalBatches = Math.ceil(allActivities.length / BATCH_SIZE);

    // Process in batches
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

        // Overall progress update
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
};

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
