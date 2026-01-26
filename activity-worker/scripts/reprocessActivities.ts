import { config } from "dotenv";
config(); // Load environment variables from .env file

import * as fs from "fs";
import * as path from "path";
import processCoords from "../helpers/processCoords";
import getCloudSqlConnection from "../helpers/getCloudSqlConnection";
import saveActivitySummits from "../helpers/saveActivitySummits";
import getHistoricalWeatherByCoords from "../helpers/getHistoricalWeatherByCoords";

/**
 * Reprocesses all activities with the new summit detection algorithm - ADDITIVE ONLY.
 * 
 * This script does NOT delete any existing summits. It only ADDS new ones:
 * 1. Fetches existing summits for each activity (fast read-only query)
 * 2. Runs new detection algorithm on activity coordinates
 * 3. Compares detected summits against existing ones (by peak_id + timestamp)
 * 4. Only fetches weather and inserts truly NEW summits
 * 
 * This is MUCH faster than delete-and-reinsert because:
 * - No weather API calls for existing summits
 * - No DB writes for activities with no new summits (~90% of activities)
 * - Preserves all existing user data automatically (no backup/restore needed)
 * 
 * RESUMABLE PROCESSING:
 * - Progress is saved to a checkpoint file after each batch
 * - If interrupted (Ctrl+C, crash, etc.), just run again to resume
 * - Checkpoint is automatically deleted on successful completion
 * 
 * Usage:
 *   npm run reprocess:activities
 * 
 * Environment variables:
 *   BATCH_SIZE - Number of activities to fetch per batch (default: 100)
 *   CONCURRENCY - Number of activities to process in parallel (default: 10)
 *   LIMIT - Maximum number of activities to process (default: all)
 *   START_FROM_ID - Start processing from this activity ID (optional, overrides checkpoint)
 *   ACTIVITY_IDS_FILE - Path to JSON file containing array of activity IDs to process (optional)
 *   WEATHER_DELAY_MS - Delay in milliseconds between weather API calls (default: 200ms)
 *   DRY_RUN - Set to "true" to preview changes without modifying the database
 *   CHECKPOINT_FILE - Path to checkpoint file (default: reprocess_checkpoint.json)
 *   SAVE_CHECKPOINT - Set to "false" to disable checkpoint saving
 * 
 * Examples:
 *   # Dry run on 100 activities (fast!)
 *   DRY_RUN=true LIMIT=100 npm run reprocess:activities
 * 
 *   # Full run (resumable - just run again if interrupted)
 *   npm run reprocess:activities
 * 
 *   # Process specific state
 *   REPROCESS_STATE=CO npm run reprocess:activities
 * 
 *   # Start fresh (ignore checkpoint)
 *   START_FROM_ID=0 npm run reprocess:activities
 */

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "100", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "10", 10);
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;
const START_FROM_ID = process.env.START_FROM_ID;
const ACTIVITY_IDS_FILE = process.env.ACTIVITY_IDS_FILE;
const WEATHER_DELAY_MS = parseInt(process.env.WEATHER_DELAY_MS ?? "200", 10); // Delay between weather API calls in milliseconds
const VERBOSE = process.env.VERBOSE !== "false"; // Default true - detailed per-activity logging
const DRY_RUN = process.env.DRY_RUN === "true"; // Dry run mode - no database writes

// Checkpoint file for resumable processing
const CHECKPOINT_FILE = process.env.CHECKPOINT_FILE ?? "reprocess_checkpoint.json";
const SAVE_CHECKPOINT = process.env.SAVE_CHECKPOINT !== "false"; // Default true - save progress for resume

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
    private newSummits: number = 0;
    private errors: number = 0;
    private total: number;

    constructor(total: number) {
        this.startTime = Date.now();
        this.total = total;
    }

    update(processed: number, summits: number, newSummits: number, errors: number) {
        this.processed += processed;
        this.summits += summits;
        this.newSummits += newSummits;
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
            newSummits: this.newSummits,
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
        console.log(`📊 PROGRESS: ${s.processed.toLocaleString()}/${s.total.toLocaleString()} (${s.pct.toFixed(1)}%)`);
        console.log(`   ⏱️  Elapsed: ${formatDuration(s.elapsedSec)} | ETA: ${formatDuration(s.etaSec)}`);
        console.log(`   📈 Rate: ${s.rate.toFixed(2)} activities/sec | ${(s.rate * 60).toFixed(1)} activities/min`);
        console.log(`   🏔️  Total summits: ${s.summits.toLocaleString()} | ✨ NEW: ${s.newSummits.toLocaleString()} | ❌ Errors: ${s.errors}`);
        console.log(`   💾 ${formatMemory()}`);
        console.log(`${"═".repeat(70)}`);
    }
}

// =========================================================================
// CHECKPOINT MANAGEMENT - for resumable processing
// =========================================================================

interface Checkpoint {
    lastProcessedId: string;
    processedCount: number;
    summitsFound: number;
    newSummitsAdded: number;
    errors: number;
    startedAt: string;
    lastUpdatedAt: string;
}

const loadCheckpoint = (): Checkpoint | null => {
    try {
        if (fs.existsSync(CHECKPOINT_FILE)) {
            const data = fs.readFileSync(CHECKPOINT_FILE, "utf-8");
            return JSON.parse(data) as Checkpoint;
        }
    } catch (err) {
        console.warn(`⚠️  Could not load checkpoint file: ${err}`);
    }
    return null;
};

const saveCheckpoint = (checkpoint: Checkpoint): void => {
    if (!SAVE_CHECKPOINT || DRY_RUN) return;
    try {
        fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
    } catch (err) {
        console.error(`❌ Failed to save checkpoint: ${err}`);
    }
};

const deleteCheckpoint = (): void => {
    try {
        if (fs.existsSync(CHECKPOINT_FILE)) {
            fs.unlinkSync(CHECKPOINT_FILE);
            console.log(`🗑️  Deleted checkpoint file: ${CHECKPOINT_FILE}`);
        }
    } catch (err) {
        console.warn(`⚠️  Could not delete checkpoint file: ${err}`);
    }
};

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
 * User data that should be preserved during reprocessing
 */
interface PreservedSummitData {
    id: string;
    peak_id: string;
    timestamp: Date;
    notes: string | null;
    difficulty: string | null;
    experience_rating: string | null;
    condition_tags: string[] | null;
    custom_condition_tags: string[] | null;
    confirmation_status: string | null;
    has_photos: boolean;
}

/**
 * Check if two timestamps are within a tolerance window (handles GPS timing drift)
 * Default 5 minutes to avoid duplicate summits from slight algorithm differences
 */
const timestampsMatch = (t1: Date, t2: Date, toleranceMinutes: number = 5): boolean => {
    const diffMs = Math.abs(t1.getTime() - t2.getTime());
    return diffMs <= toleranceMinutes * 60 * 1000;
};

/**
 * Dry-run result for detailed logging
 */
interface DryRunResult {
    activityId: string;
    existingSummits: number;
    newSummitsFound: number;
    newSummitsAdded: number;
    details: string[];
}

/**
 * Process a single activity - ADDITIVE ONLY approach
 * 
 * This does NOT delete any existing summits. It only:
 * 1. Runs detection with the new algorithm
 * 2. Compares detected summits against existing ones
 * 3. Inserts only truly NEW summits (ones not already in DB)
 * 
 * This is much faster because:
 * - No weather API calls for existing summits
 * - No DB writes if no new summits found
 * - Preserves all existing user data automatically
 */
const processActivity = async (
    activity: ActivityRow,
    pool: any
): Promise<{ summits: number; newSummits: number; success: boolean; error?: string; dryRunResult?: DryRunResult }> => {
    const dryRunDetails: string[] = [];
    
    try {
        // Check if activity type is excluded - skip entirely (no deletions in additive mode)
        const sportType = activity.activity_json?.sport_type;
        if (sportType && EXCLUDED_SPORT_TYPES.includes(sportType)) {
            if (DRY_RUN) {
                dryRunDetails.push(`⏭️  Skipped: excluded sport type "${sportType}"`);
                return { 
                    summits: 0, 
                    newSummits: 0,
                    success: true, 
                    dryRunResult: {
                        activityId: activity.id,
                        existingSummits: 0,
                        newSummitsFound: 0,
                        newSummitsAdded: 0,
                        details: dryRunDetails
                    }
                };
            }
            return { summits: 0, newSummits: 0, success: true };
        }

        // Parse coordinates from GeoJSON
        const geo = JSON.parse(activity.coords);
        const coords = geo.coordinates as [number, number][];

        if (!coords || coords.length === 0) {
            return { summits: 0, newSummits: 0, success: true };
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

        // STEP 1: Get existing summits (just peak_id + timestamp for comparison)
        const { rows: existingData } = await pool.query(
            `SELECT peak_id, timestamp FROM activities_peaks WHERE activity_id = $1`,
            [activity.id]
        );

        // Store existing summits as array for 10-minute tolerance matching
        const existingSummits: Array<{ peak_id: string; timestamp: Date }> = existingData.map((row: any) => ({
            peak_id: row.peak_id,
            timestamp: new Date(row.timestamp)
        }));

        if (DRY_RUN) {
            dryRunDetails.push(`📊 Existing summits: ${existingSummits.length}`);
        }

        // STEP 2: Run detection with new algorithm
        const detectedSummits = await processCoords(coords, times, altitudes);
        
        if (DRY_RUN) {
            dryRunDetails.push(`🔍 Detection found: ${detectedSummits.length} summit(s)`);
        }

        if (detectedSummits.length === 0) {
            if (DRY_RUN) {
                dryRunDetails.push(`✅ No summits detected, nothing to add`);
                return { 
                    summits: existingData.length, 
                    newSummits: 0,
                    success: true,
                    dryRunResult: {
                        activityId: activity.id,
                        existingSummits: existingData.length,
                        newSummitsFound: 0,
                        newSummitsAdded: 0,
                        details: dryRunDetails
                    }
                };
            }
            return { summits: existingData.length, newSummits: 0, success: true };
        }

        // STEP 3: Find truly NEW summits (not already in DB)
        const startTime = new Date(activity.start_time).getTime();
        const newSummitsToAdd: Array<{
            peakId: string;
            timestamp: Date;
            activityId: number;
            weather: any;
            confidenceScore: number;
            needsConfirmation: boolean;
            lat: number;
            lng: number;
            elevation?: number;
        }> = [];

        for (const summit of detectedSummits) {
            // Calculate timestamp for this summit
            const timestamp =
                times && times[summit.index] !== undefined
                    ? new Date(startTime + times[summit.index] * 1000)
                    : new Date(activity.start_time);
            
            // Check if this summit already exists (by peak_id + timestamp within 5 minute tolerance)
            const alreadyExists = existingSummits.some(existing => 
                existing.peak_id === summit.id && 
                timestampsMatch(existing.timestamp, timestamp, 5) // 5 minute tolerance
            );
            
            if (alreadyExists) {
                if (DRY_RUN) {
                    dryRunDetails.push(`   ⏭️  Peak ${summit.id} @ ${timestamp.toISOString()} (already exists within 5min)`);
                }
                continue;
            }
            
            // This is a NEW summit!
            newSummitsToAdd.push({
                peakId: summit.id,
                timestamp,
                activityId: parseInt(activity.id, 10),
                weather: { temperature: 0, precipitation: 0, weatherCode: 0, cloudCover: 0, windSpeed: 0, windDirection: 0, humidity: 0 },
                confidenceScore: summit.confidenceScore,
                needsConfirmation: summit.needsConfirmation,
                lat: summit.lat,
                lng: summit.lng,
                elevation: summit.elevation,
            });
            
            if (DRY_RUN) {
                const confStr = summit.needsConfirmation ? '⚠️' : '✅';
                dryRunDetails.push(`   ${confStr} Peak ${summit.id} @ ${timestamp.toISOString()} conf=${summit.confidenceScore.toFixed(2)} (NEW!)`);
            }
        }

        // If no new summits, we're done (fast path - no DB writes!)
        if (newSummitsToAdd.length === 0) {
            if (DRY_RUN) {
                dryRunDetails.push(`✅ All ${detectedSummits.length} detected summits already exist`);
                return { 
                    summits: existingData.length, 
                    newSummits: 0,
                    success: true,
                    dryRunResult: {
                        activityId: activity.id,
                        existingSummits: existingData.length,
                        newSummitsFound: detectedSummits.length,
                        newSummitsAdded: 0,
                        details: dryRunDetails
                    }
                };
            }
            return { summits: existingData.length, newSummits: 0, success: true };
        }

        // STEP 4: Fetch weather and save ONLY the new summits
        if (!DRY_RUN) {
            for (let i = 0; i < newSummitsToAdd.length; i++) {
                const summit = newSummitsToAdd[i];
                
                // Add delay between weather API calls (except for the first one)
                if (i > 0) {
                    await new Promise((resolve) => setTimeout(resolve, WEATHER_DELAY_MS));
                }
                
                summit.weather = await getHistoricalWeatherByCoords(
                    summit.timestamp,
                    { lat: summit.lat, lon: summit.lng },
                    summit.elevation ?? 0
                );
            }

            // Save new summits
            await saveActivitySummits(
                newSummitsToAdd,
                activity.id,
                activity.is_public,
                utcOffsetSeconds
            );
        }

        if (DRY_RUN) {
            dryRunDetails.push(`📈 Summary: ${existingData.length} existing + ${newSummitsToAdd.length} NEW = ${existingData.length + newSummitsToAdd.length} total`);
            return { 
                summits: existingData.length + newSummitsToAdd.length, 
                newSummits: newSummitsToAdd.length,
                success: true,
                dryRunResult: {
                    activityId: activity.id,
                    existingSummits: existingData.length,
                    newSummitsFound: detectedSummits.length,
                    newSummitsAdded: newSummitsToAdd.length,
                    details: dryRunDetails
                }
            };
        }
        
        return { summits: existingData.length + newSummitsToAdd.length, newSummits: newSummitsToAdd.length, success: true };
    } catch (error) {
        return {
            summits: 0,
            newSummits: 0,
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
): Promise<{ processed: number; summits: number; newSummits: number; errors: number }> => {
    let processed = 0;
    let totalSummits = 0;
    let totalNewSummits = 0;
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
                const { summits, newSummits, success, error, dryRunResult } = result.value;
                if (success) {
                    processed++;
                    totalSummits += summits;
                    totalNewSummits += newSummits;
                    
                    // In dry-run mode, show detailed output only if there are new summits
                    if (DRY_RUN && dryRunResult) {
                        if (newSummits > 0 || VERBOSE) {
                            console.log(`\n  ${"─".repeat(60)}`);
                            console.log(`  🔬 DRY RUN: Activity ${activity.id}`);
                            for (const detail of dryRunResult.details) {
                                console.log(`  ${detail}`);
                            }
                        }
                    } else if (VERBOSE && newSummits > 0) {
                        console.log(
                            `  [${getTimestamp()}] ✅ ${activity.id} → +${newSummits} NEW summit(s)`
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
            `  [${getTimestamp()}] Batch ${batchNum}/${totalBatches} │ ${i + chunk.length}/${activities.length} (${chunkProgress}%) │ +${totalNewSummits} new │ ${batchElapsed}s total`
        );
    }

    return { processed, summits: totalSummits, newSummits: totalNewSummits, errors };
};

const main = async () => {
    const pool = await getCloudSqlConnection();

    // Check for existing checkpoint to resume from
    const existingCheckpoint = loadCheckpoint();
    let resumeFromId: string | null = null;
    let resumeStats = { processed: 0, summits: 0, newSummits: 0, errors: 0 };
    
    if (existingCheckpoint && !START_FROM_ID && !DRY_RUN) {
        console.log(`\n${"═".repeat(70)}`);
        console.log(`📥 FOUND EXISTING CHECKPOINT`);
        console.log(`${"═".repeat(70)}`);
        console.log(`   Last processed ID: ${existingCheckpoint.lastProcessedId}`);
        console.log(`   Progress: ${existingCheckpoint.processedCount.toLocaleString()} activities`);
        console.log(`   Summits found: ${existingCheckpoint.summitsFound.toLocaleString()}`);
        console.log(`   NEW summits added: ${existingCheckpoint.newSummitsAdded.toLocaleString()}`);
        console.log(`   Started: ${existingCheckpoint.startedAt}`);
        console.log(`   Last updated: ${existingCheckpoint.lastUpdatedAt}`);
        console.log(`${"═".repeat(70)}`);
        console.log(`\n🔄 Resuming from last checkpoint...\n`);
        
        resumeFromId = existingCheckpoint.lastProcessedId;
        resumeStats = {
            processed: existingCheckpoint.processedCount,
            summits: existingCheckpoint.summitsFound,
            newSummits: existingCheckpoint.newSummitsAdded,
            errors: existingCheckpoint.errors,
        };
    }

    console.log(`\n${"═".repeat(70)}`);
    if (DRY_RUN) {
        console.log(`🔬 PATHQUEST ACTIVITY REPROCESSOR - DRY RUN MODE`);
        console.log(`   ⚠️  No database changes will be made!`);
    } else {
        console.log(`🏔️  PATHQUEST ACTIVITY REPROCESSOR`);
    }
    console.log(`${"═".repeat(70)}`);
    console.log(`   Started at: ${new Date().toISOString()}`);
    console.log(`   📦 Batch size: ${BATCH_SIZE}`);
    console.log(`   🔄 Concurrency: ${CONCURRENCY} parallel`);
    if (!DRY_RUN) console.log(`   🌤️  Weather delay: ${WEATHER_DELAY_MS}ms`);
    console.log(`   📝 Verbose logging: ${VERBOSE ? "ON" : "OFF"}`);
    if (DRY_RUN) console.log(`   🔬 DRY RUN: ON`);
    if (SAVE_CHECKPOINT && !DRY_RUN) console.log(`   💾 Checkpoint file: ${CHECKPOINT_FILE}`);
    if (LIMIT) console.log(`   🎯 Limit: ${LIMIT} activities`);
    if (START_FROM_ID) console.log(`   ⏭️  Start from ID: ${START_FROM_ID}`);
    if (resumeFromId) console.log(`   🔄 Resuming from ID: ${resumeFromId}`);
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
        let totalNewSummits = 0;
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
            totalNewSummits += result.newSummits;
            totalErrors += result.errors;

            const overallProgress = ((i + batch.length) / allActivities.length * 100).toFixed(1);
            console.log(
                `\nBatch ${batchNum} complete in ${elapsed}s - Overall: ${i + batch.length}/${allActivities.length} (${overallProgress}%)`
            );
            console.log(
                `  Total summits: ${totalSummits} | NEW: ${totalNewSummits} | Errors: ${totalErrors} | Processed: ${totalProcessed}`
            );
        }

        console.log("\n" + "=".repeat(60));
        console.log("Reprocessing complete!");
        console.log(`Total activities processed: ${totalProcessed}`);
        console.log(`Total summits: ${totalSummits}`);
        console.log(`NEW summits added: ${totalNewSummits}`);
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

    // Initialize progress tracker - account for already processed if resuming
    const remainingToProcess = effectiveLimit - resumeStats.processed;
    const progress = new ProgressTracker(effectiveLimit);
    // Pre-populate progress with resume stats
    if (resumeStats.processed > 0) {
        progress.update(resumeStats.processed, resumeStats.summits, resumeStats.newSummits, resumeStats.errors);
    }
    
    // Use checkpoint ID if resuming, otherwise null
    let lastId: string | null = resumeFromId;
    let batchNum = resumeStats.processed > 0 ? Math.floor(resumeStats.processed / BATCH_SIZE) : 0;
    const estimatedBatches = Math.ceil(effectiveLimit / BATCH_SIZE);
    
    // Initialize checkpoint for new runs
    const startedAt = existingCheckpoint?.startedAt ?? new Date().toISOString();

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

        progress.update(result.processed, result.summits, result.newSummits, result.errors);

        // Save checkpoint after each batch (for resumable processing)
        const stats = progress.getStats();
        saveCheckpoint({
            lastProcessedId: lastId!,
            processedCount: stats.processed,
            summitsFound: stats.summits,
            newSummitsAdded: stats.newSummits,
            errors: stats.errors,
            startedAt,
            lastUpdatedAt: new Date().toISOString(),
        });

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
    console.log(`   🏔️  Total summits: ${stats.summits.toLocaleString()}`);
    console.log(`   ✨ NEW summits added: ${stats.newSummits.toLocaleString()}`);
    console.log(`   ❌ Errors: ${stats.errors}`);
    console.log(`   ⏱️  Total time: ${formatDuration(stats.elapsedSec)}`);
    console.log(`   📈 Average rate: ${stats.rate.toFixed(2)} activities/sec`);
    console.log(`   💾 Final ${formatMemory()}`);
    console.log(`${"═".repeat(70)}`);
    
    // Delete checkpoint on successful completion
    if (!DRY_RUN && stats.errors === 0) {
        deleteCheckpoint();
        console.log(`\n✅ Successfully completed! Checkpoint deleted.`);
    } else if (stats.errors > 0) {
        console.log(`\n⚠️  Completed with ${stats.errors} errors. Checkpoint preserved for review.`);
    }

    await pool.end();
    process.exit(0);
};

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
