import { config } from "dotenv";
config();

import { Pool } from "pg";
import { spawn } from "child_process";
import getCloudSqlConnection from "./getCloudSqlConnection";

type PeakSeedRow = {
    id: string;
    name: string;
    lat: number | null;
    lon: number | null;
    elevation: number | null;
    source_origin: string | null;
};

// Helper to safely format numbers (handles null, undefined, strings, etc.)
const safeToFixed = (val: any, decimals: number): string => {
    if (val == null) return "?";
    const num = typeof val === "number" ? val : Number.parseFloat(String(val));
    return Number.isNaN(num) ? "?" : num.toFixed(decimals);
};

type SnapCandidate = {
    snapped_lat: number;
    snapped_lon: number;
    elevation_m: number;
    snapped_distance_m: number;
    confidence: number;
    radial_score: number;
    neighborhood_score: number;
    ml_probability?: number;  // Added for ML-based snapping
};

type SnapResult = {
    peak_id: string;
    candidates?: SnapCandidate[];
    error?: string;
};

type ClaimedCoord = {
    lat: number;
    lon: number;
    peakId: string;
};

const haversineM = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const r = 6371000.0;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dphi = ((lat2 - lat1) * Math.PI) / 180;
    const dl = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
};

const hasColumn = async (pool: Pool, table: string, column: string): Promise<boolean> => {
    const { rows } = await pool.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = $1
              AND column_name = $2
        ) AS exists
    `,
        [table, column]
    );
    return Boolean(rows[0]?.exists);
};

const hasTable = async (pool: Pool, table: string): Promise<boolean> => {
    const { rows } = await pool.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = $1
        ) AS exists
    `,
        [table]
    );
    return Boolean(rows[0]?.exists);
};

const runPythonSnap = async (
    pythonBin: string,
    scriptPath: string,
    demPath: string,
    inputs: { peak_id: string; lat: number; lon: number; radius_m: number; top_k: number; min_separation_m: number; require_local_max: boolean }[]
): Promise<SnapResult[]> => {
    return await new Promise((resolve, reject) => {
        const child = spawn(pythonBin, [scriptPath, "--dem", demPath], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        const out: SnapResult[] = [];
        let stderr = "";

        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (d) => {
            stderr += String(d);
        });

        child.stdout.setEncoding("utf-8");
        let buf = "";
        child.stdout.on("data", (d) => {
            buf += String(d);
            while (true) {
                const idx = buf.indexOf("\n");
                if (idx === -1) break;
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                try {
                    out.push(JSON.parse(line) as SnapResult);
                } catch (e) {
                    out.push({ peak_id: "(unknown)", error: `bad_json: ${line}` });
                }
            }
        });

        child.on("error", (err) => reject(err));

        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`Python exited with code ${code}. stderr=${stderr}`));
                return;
            }
            resolve(out);
        });

        for (const rec of inputs) {
            child.stdin.write(JSON.stringify(rec) + "\n");
        }
        child.stdin.end();
    });
};

// ML-based snapping using trained model
type MLSnapInput = {
    peak_id: string;
    lat: number;
    lon: number;
    radius_m: number;
    seed_lat?: number;
    seed_lon?: number;
};

type MLSnapResult = {
    peak_id: string;
    snapped_lat?: number;
    snapped_lon?: number;
    elevation_m?: number;
    ml_probability?: number;
    snapped_distance_m?: number;
    candidates_evaluated?: number;
    highest_elev_candidate?: {
        lat: number;
        lon: number;
        elevation_m: number;
        ml_probability: number;
    } | null;
    error?: string;
};

const runPythonMLSnap = async (
    pythonBin: string,
    scriptPath: string,
    demPath: string,
    modelPath: string,
    inputs: MLSnapInput[]
): Promise<MLSnapResult[]> => {
    return await new Promise((resolve, reject) => {
        const child = spawn(pythonBin, [
            scriptPath,
            "--dem-path", demPath,
            "--model-path", modelPath,
        ], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        const out: MLSnapResult[] = [];
        let stderr = "";

        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (d) => {
            stderr += String(d);
        });

        child.stdout.setEncoding("utf-8");
        let buf = "";
        child.stdout.on("data", (d) => {
            buf += String(d);
            while (true) {
                const idx = buf.indexOf("\n");
                if (idx === -1) break;
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                try {
                    out.push(JSON.parse(line) as MLSnapResult);
                } catch (e) {
                    out.push({ peak_id: "(unknown)", error: `bad_json: ${line}` });
                }
            }
        });

        child.on("error", (err) => reject(err));

        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`Python ML script exited with code ${code}. stderr=${stderr}`));
                return;
            }
            resolve(out);
        });

        for (const rec of inputs) {
            child.stdin.write(JSON.stringify(rec) + "\n");
        }
        child.stdin.end();
    });
};

type CollisionResult = {
    candidate: SnapCandidate;
    collidedWith: string | null;
    collisionDistM: number | null;
    candidatesSkipped: number;
    skippedCollisions: { peakId: string; distM: number }[];
};

const findFirstUnclaimedCandidate = (
    candidates: SnapCandidate[],
    claimed: ClaimedCoord[],
    collisionRadiusM: number,
    currentPeakId?: string  // Skip collision with self (for reprocessing)
): CollisionResult | null => {
    const skippedCollisions: { peakId: string; distM: number }[] = [];
    
    for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        let collision: { peakId: string; distM: number } | null = null;
        
        for (const cl of claimed) {
            // Skip self-collision when reprocessing
            if (currentPeakId && cl.peakId === currentPeakId) {
                continue;
            }
            const dist = haversineM(cand.snapped_lat, cand.snapped_lon, cl.lat, cl.lon);
            if (dist < collisionRadiusM) {
                collision = { peakId: cl.peakId, distM: dist };
                break;
            }
        }
        
        if (!collision) {
            return { 
                candidate: cand, 
                collidedWith: null, 
                collisionDistM: null,
                candidatesSkipped: i,
                skippedCollisions 
            };
        }
        skippedCollisions.push(collision);
    }
    
    // All candidates collided; return the first one anyway but mark the collision
    if (candidates.length > 0) {
        for (const cl of claimed) {
            const dist = haversineM(candidates[0].snapped_lat, candidates[0].snapped_lon, cl.lat, cl.lon);
            if (dist < collisionRadiusM) {
                return { 
                    candidate: candidates[0], 
                    collidedWith: cl.peakId, 
                    collisionDistM: dist,
                    candidatesSkipped: candidates.length - 1,
                    skippedCollisions: skippedCollisions.slice(1)
                };
            }
        }
    }
    return null;
};

export default async function snapPeaksToHighest3dep(): Promise<void> {
    const pool = await getCloudSqlConnection();

    const demPath = process.env.DEM_VRT_PATH;
    if (!demPath) {
        throw new Error("DEM_VRT_PATH is required (path to Colorado 3DEP VRT/GeoTIFF)");
    }
    const demPathFallback = process.env.DEM_VRT_PATH_FALLBACK ?? "";

    const pythonBin = process.env.PYTHON_BIN ?? "python3";
    const pythonScript = process.env.SNAP_PY_SCRIPT ?? "python/snap_to_highest.py";
    
    // ML-based snapping (optional) - uses same confidence threshold as heuristic
    const useMLSnapping = process.env.SNAP_USE_ML === "true";
    const mlScript = process.env.SNAP_ML_SCRIPT ?? "python/ml/predict_summit.py";
    const mlModelPath = process.env.SUMMIT_MODEL_PATH ?? "python/ml/models/summit_model.joblib";

    const state = process.env.SNAP_STATE ?? ""; // empty = no filter
    const country = process.env.SNAP_COUNTRY ?? ""; // empty = no filter
    const sourceOrigin = process.env.SNAP_SOURCE_ORIGIN ?? ""; // e.g., "14ers", "osm" - empty = no filter
    const hasExternalSource = process.env.SNAP_HAS_EXTERNAL_SOURCE ?? ""; // e.g., "14ers" - filter peaks with this external ID source
    const elevationMin = Number.parseFloat(process.env.SNAP_ELEVATION_MIN_M ?? "3962"); // ~13,000 ft
    
    // Safety check: require at least one geographic or source filter
    const peakIdsFromEnv = (process.env.SNAP_PEAK_IDS ?? "").trim();
    const peakNameFromEnv = (process.env.SNAP_PEAK_NAME_ILIKE ?? "").trim();
    if (!country && !state && !sourceOrigin && !hasExternalSource && !peakIdsFromEnv && !peakNameFromEnv) {
        throw new Error("At least one filter required: SNAP_COUNTRY, SNAP_STATE, SNAP_SOURCE_ORIGIN, SNAP_HAS_EXTERNAL_SOURCE, SNAP_PEAK_IDS, or SNAP_PEAK_NAME_ILIKE");
    }
    const batchSize = Number.parseInt(process.env.SNAP_BATCH_SIZE ?? "500", 10);
    const maxBatches = process.env.SNAP_MAX_BATCHES ? Number.parseInt(process.env.SNAP_MAX_BATCHES, 10) : undefined;
    const acceptMaxDistance = Number.parseFloat(process.env.SNAP_ACCEPT_MAX_DISTANCE_M ?? "300");
    const dryRun = process.env.SNAP_DRY_RUN === "true";
    const forceReprocess = process.env.SNAP_FORCE_REPROCESS === "true";

    // Collision avoidance params
    const topK = Number.parseInt(process.env.SNAP_TOP_K ?? "5", 10);
    const candidateSeparationM = Number.parseFloat(process.env.SNAP_CANDIDATE_SEPARATION_M ?? "30");
    const collisionRadiusM = Number.parseFloat(process.env.SNAP_COLLISION_RADIUS_M ?? "50");
    const requireLocalMax = process.env.SNAP_REQUIRE_LOCAL_MAX !== "false"; // default true

    // Peak detection params (scipy-based)
    const neighborhoodSize = Number.parseInt(process.env.SNAP_NEIGHBORHOOD_SIZE ?? "5", 10); // 5x5 window
    const gaussianSigma = Number.parseFloat(process.env.SNAP_GAUSSIAN_SIGMA ?? "1.0"); // noise smoothing
    const preferNearest = process.env.SNAP_PREFER_NEAREST !== "false"; // default true

    // Confidence thresholds
    const confidenceAcceptMin = Number.parseFloat(process.env.SNAP_CONFIDENCE_ACCEPT_MIN ?? "0.75"); // auto-accept threshold
    const confidenceRejectMax = Number.parseFloat(process.env.SNAP_CONFIDENCE_REJECT_MAX ?? "0.4"); // try next candidate threshold

    const peakIdsFilter = (process.env.SNAP_PEAK_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const peakNameLike = (process.env.SNAP_PEAK_NAME_ILIKE ?? "").trim();

    const radiusOsm = Number.parseFloat(process.env.SNAP_RADIUS_OSM_M ?? "250");
    const radiusPeakbagger = Number.parseFloat(process.env.SNAP_RADIUS_PEAKBAGGER_M ?? "150");
    const radius14ers = Number.parseFloat(process.env.SNAP_RADIUS_14ERS_M ?? "0"); // 0 = skip 14ers peaks
    const skip14ersPeaks = process.env.SNAP_SKIP_14ERS !== "false"; // default true - don't snap peaks from 14ers.com

    const includeLocationGeom = await hasColumn(pool, "peaks", "location_geom");
    const seedExpr = "COALESCE(seed_coords, " + (includeLocationGeom ? "location_geom" : "location_coords::geometry") + ")";
    const hasPublicLandsChecked = await hasColumn(pool, "peaks", "public_lands_checked");
    const hasPeaksPublicLands = await hasTable(pool, "peaks_public_lands");

    console.log("\n" + "═".repeat(80));
    console.log("SNAP-TO-HIGHEST (3DEP) - Node orchestrator + Python rasterio");
    console.log("═".repeat(80));
    console.log(`Country: ${country || "(all)"}`);
    console.log(`State: ${state || "(all)"}`);
    if (sourceOrigin) {
        console.log(`Source origin filter: ${sourceOrigin}`);
    }
    if (hasExternalSource) {
        console.log(`Has external ID from: ${hasExternalSource}`);
    }
    console.log(`Elevation min (m): ${elevationMin}`);
    console.log(`Batch size: ${batchSize}`);
    console.log(`Accept max distance (m): ${acceptMaxDistance}`);
    console.log(`DEM: ${demPath}`);
    if (demPathFallback) {
        console.log(`DEM fallback: ${demPathFallback}`);
    }
    console.log(`Dry run (no DB writes): ${dryRun ? "YES" : "NO"}`);
    if (forceReprocess) {
        console.log(`Force reprocess: YES (ignoring coords_snapped_at)`);
    }
    console.log(`ML snapping: ${useMLSnapping ? "YES" : "NO (heuristic)"}`);
    if (useMLSnapping) {
        console.log(`ML model: ${mlModelPath}`);
    }
    console.log(`Skip 14ers.com peaks: ${skip14ersPeaks ? "YES" : "NO"}`);
    console.log(`Radius - OSM: ${radiusOsm}m, Peakbagger: ${radiusPeakbagger}m, 14ers: ${radius14ers}m`);
    console.log(`Top K candidates: ${topK}`);
    console.log(`Candidate separation (m): ${candidateSeparationM}`);
    console.log(`Collision radius (m): ${collisionRadiusM}`);
    console.log(`Require local maximum: ${requireLocalMax ? "YES" : "NO"}`);
    console.log(`Neighborhood size: ${neighborhoodSize}x${neighborhoodSize}`);
    console.log(`Gaussian sigma: ${gaussianSigma}${gaussianSigma > 0 ? "" : " (disabled)"}`);
    console.log(`Prefer nearest (among similar elevations): ${preferNearest ? "YES" : "NO"}`);
    console.log(`Confidence thresholds: accept >= ${confidenceAcceptMin}, reject < ${confidenceRejectMax}`);
    if (peakIdsFilter.length > 0) {
        console.log(`Peak ID filter: ${peakIdsFilter.length} ids`);
    }
    if (peakNameLike) {
        console.log(`Peak name filter (ILIKE): ${peakNameLike}`);
    }
    if (hasPublicLandsChecked && hasPeaksPublicLands) {
        console.log(`Public lands reset-on-accept: ENABLED`);
    } else {
        console.log(`Public lands reset-on-accept: DISABLED (missing public_lands_checked and/or peaks_public_lands)`);
    }

    // Track claimed coordinates globally (across all batches)
    const claimedCoords: ClaimedCoord[] = [];

    // First, load any already-snapped peaks' coordinates into claimed set
    console.log("\nLoading already-snapped peaks to avoid collisions...");
    const alreadySnappedWhere: string[] = [
        "p.coords_snapped_at IS NOT NULL",
        "p.location_geom IS NOT NULL",
    ];
    const alreadySnappedParams: any[] = [];
    if (country) {
        alreadySnappedParams.push(country);
        alreadySnappedWhere.push(`p.country = $${alreadySnappedParams.length}`);
    }
    if (state) {
        alreadySnappedParams.push(state);
        alreadySnappedWhere.push(`p.state = $${alreadySnappedParams.length}`);
    }
    if (sourceOrigin) {
        alreadySnappedParams.push(sourceOrigin);
        alreadySnappedWhere.push(`p.source_origin = $${alreadySnappedParams.length}`);
    }
    if (hasExternalSource) {
        alreadySnappedParams.push(hasExternalSource);
        alreadySnappedWhere.push(`EXISTS (SELECT 1 FROM peak_external_ids pei WHERE pei.peak_id = p.id AND pei.source = $${alreadySnappedParams.length})`);
    }
    const { rows: alreadySnapped } = await pool.query<{ id: string; lat: number; lon: number }>(
        `
        SELECT p.id, ST_Y(p.location_geom) AS lat, ST_X(p.location_geom) AS lon
        FROM peaks p
        WHERE ${alreadySnappedWhere.join("\n          AND ")}
    `,
        alreadySnappedParams
    );
    for (const row of alreadySnapped) {
        claimedCoords.push({ lat: row.lat, lon: row.lon, peakId: row.id });
    }
    console.log(`Loaded ${claimedCoords.length} already-snapped peaks.`);

    // Get total count of peaks to process for progress reporting
    const countWhereParts: string[] = [];
    const countParams: any[] = [];
    if (country) {
        countParams.push(country);
        countWhereParts.push(`p.country = $${countParams.length}`);
    }
    if (state) {
        countParams.push(state);
        countWhereParts.push(`p.state = $${countParams.length}`);
    }
    if (sourceOrigin) {
        countParams.push(sourceOrigin);
        countWhereParts.push(`p.source_origin = $${countParams.length}`);
    }
    if (hasExternalSource) {
        countParams.push(hasExternalSource);
        countWhereParts.push(`EXISTS (SELECT 1 FROM peak_external_ids pei WHERE pei.peak_id = p.id AND pei.source = $${countParams.length})`);
    }
    countParams.push(elevationMin);
    countWhereParts.push(`
          (
                (p.elevation IS NOT NULL AND p.elevation >= $${countParams.length})
             OR EXISTS (
                SELECT 1
                FROM peak_external_ids pei
                WHERE pei.peak_id = p.id
                  AND pei.source = 'peakbagger'
             )
             OR EXISTS (
                SELECT 1
                FROM peak_external_ids pei
                WHERE pei.peak_id = p.id
                  AND pei.source = '14ers'
             )
          )
    `);
    // Allow forcing reprocess of already-snapped peaks (for testing)
    if (!forceReprocess) {
        countWhereParts.push(`(p.coords_snapped_at IS NULL)`);
    }
    
    if (peakIdsFilter.length > 0) {
        countParams.push(peakIdsFilter);
        countWhereParts.push(`p.id = ANY($${countParams.length}::varchar[])`);
    }
    if (peakNameLike) {
        countParams.push(peakNameLike);
        countWhereParts.push(`p.name ILIKE $${countParams.length}`);
    }

    const { rows: countRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM peaks p WHERE ${countWhereParts.join("\n              AND ")}`,
        countParams
    );
    const totalToProcess = parseInt(countRows[0]?.count ?? "0", 10);
    console.log(`\n📊 Peaks to process: ${totalToProcess}`);

    // Global counters for final summary
    let totalAccepted = 0;
    let totalReview = 0;
    let totalErrors = 0;
    let totalCollisions = 0;
    let totalFallbackUsed = 0;
    let totalProcessed = 0;
    const startTime = Date.now();

    // Track processed peaks in memory for dry runs (since DB isn't updated)
    const processedPeakIds = new Set<string>();

    let batch = 0;
    while (true) {
        batch += 1;
        if (maxBatches && batch > maxBatches) {
            console.log(`Reached SNAP_MAX_BATCHES=${maxBatches}; stopping.`);
            break;
        }

        const whereParts: string[] = [];
        const params: any[] = [];
        if (country) {
            params.push(country);
            whereParts.push(`p.country = $${params.length}`);
        }
        if (state) {
            params.push(state);
            whereParts.push(`p.state = $${params.length}`);
        }
        if (sourceOrigin) {
            params.push(sourceOrigin);
            whereParts.push(`p.source_origin = $${params.length}`);
        }
        if (hasExternalSource) {
            params.push(hasExternalSource);
            whereParts.push(`EXISTS (SELECT 1 FROM peak_external_ids pei WHERE pei.peak_id = p.id AND pei.source = $${params.length})`);
        }

        params.push(elevationMin);
        whereParts.push(`
              (
                    (p.elevation IS NOT NULL AND p.elevation >= $${params.length})
                 OR EXISTS (
                    SELECT 1
                    FROM peak_external_ids pei
                    WHERE pei.peak_id = p.id
                      AND pei.source = 'peakbagger'
                 )
              )
        `);

        if (!forceReprocess) {
            whereParts.push(`(p.coords_snapped_at IS NULL)`);
        }

        // Exclude peaks we've already processed in this session (prevents re-fetching failed peaks)
        if (processedPeakIds.size > 0) {
            params.push(Array.from(processedPeakIds));
            whereParts.push(`p.id != ALL($${params.length}::varchar[])`);
        }

        if (peakIdsFilter.length > 0) {
            params.push(peakIdsFilter);
            whereParts.push(`p.id = ANY($${params.length}::varchar[])`);
        }
        if (peakNameLike) {
            params.push(peakNameLike);
            whereParts.push(`p.name ILIKE $${params.length}`);
        }

        params.push(batchSize);
        const limitParam = `$${params.length}`;

        // ORDER BY elevation DESC so highest peaks get first dibs on coordinates
        const { rows } = await pool.query<PeakSeedRow>(
            `
            SELECT
                p.id,
                p.name,
                ST_Y(${seedExpr}) AS lat,
                ST_X(${seedExpr}) AS lon,
                p.elevation,
                p.source_origin
            FROM peaks p
            WHERE ${whereParts.join("\n              AND ")}
            ORDER BY p.elevation DESC NULLS LAST
            LIMIT ${limitParam}
        `,
            params
        );

        if (rows.length === 0) {
            console.log("No more peaks to snap.");
            break;
        }

        // Filter out rows with null coordinates
        const validRows = rows.filter((r) => r.lat != null && r.lon != null);
        const skippedRows = rows.length - validRows.length;
        if (skippedRows > 0) {
            console.log(`  ⚠️  Skipping ${skippedRows} peak(s) with null coordinates`);
            for (const r of rows) {
                if (r.lat == null || r.lon == null) {
                    console.log(`     ${r.name} (${r.id}): missing coordinates`);
                }
            }
        }

        if (validRows.length === 0) {
            console.log("No valid peaks in this batch (all have null coordinates).");
            continue;
        }

        // Skip 14ers peaks if configured (they already have excellent coords)
        const rowsToProcess = skip14ersPeaks
            ? validRows.filter((r) => r.source_origin !== "14ers")
            : validRows;

        if (rowsToProcess.length === 0 && validRows.length > 0) {
            console.log(`  All ${validRows.length} peaks in this batch are from 14ers.com (skipped)`);
            // Mark them as processed in dry run tracking
            for (const r of validRows) {
                processedPeakIds.add(r.id);
            }
            continue;
        }

        if (rowsToProcess.length < validRows.length) {
            console.log(`  Skipping ${validRows.length - rowsToProcess.length} peaks from 14ers.com`);
        }

        // Determine radius based on source: 14ers (tight) > peakbagger (medium) > osm (wide)
        const getRadius = (r: PeakSeedRow): number => {
            if (r.source_origin === "14ers") return radius14ers;
            if (r.source_origin === "peakbagger") return radiusPeakbagger;
            return radiusOsm;
        };

        const inputs = rowsToProcess.map((r) => ({
            peak_id: r.id,
            lat: r.lat!,
            lon: r.lon!,
            radius_m: getRadius(r),
            top_k: topK,
            min_separation_m: candidateSeparationM,
            require_local_max: requireLocalMax,
            neighborhood_size: neighborhoodSize,
            gaussian_sigma: gaussianSigma,
            prefer_nearest: preferNearest,
        }));

        const progressPct = totalToProcess > 0 
            ? ((totalProcessed / totalToProcess) * 100).toFixed(1)
            : "0.0";
        const elapsedSec = (Date.now() - startTime) / 1000;
        const peaksPerSec = totalProcessed > 0 ? totalProcessed / elapsedSec : 0;
        const remaining = totalToProcess - totalProcessed;
        const etaSec = peaksPerSec > 0 ? remaining / peaksPerSec : 0;
        const etaStr = etaSec > 60 
            ? `${Math.floor(etaSec / 60)}m ${Math.floor(etaSec % 60)}s`
            : `${Math.floor(etaSec)}s`;
        
        console.log(`\n${"═".repeat(60)}`);
        console.log(`Batch ${batch}: snapping ${inputs.length} peaks (highest first)${useMLSnapping ? " [ML]" : ""}`);
        console.log(`Progress: ${totalProcessed}/${totalToProcess} (${progressPct}%) | ETA: ${totalProcessed > 0 ? etaStr : "calculating..."}`);
        
        // Choose between ML and heuristic snapping
        let results: SnapResult[];
        if (useMLSnapping) {
            // ML-based snapping
            const mlInputs: MLSnapInput[] = inputs.map((inp) => ({
                peak_id: inp.peak_id,
                lat: inp.lat,
                lon: inp.lon,
                radius_m: inp.radius_m,
            }));
            
            const mlResults = await runPythonMLSnap(pythonBin, mlScript, demPath, mlModelPath, mlInputs);
            
            // Convert ML results to SnapResult format
            results = mlResults.map((mr) => {
                if (mr.error || mr.snapped_lat === undefined || mr.snapped_lon === undefined) {
                    return { peak_id: mr.peak_id, error: mr.error ?? "ml_failed" };
                }
                
                const candidate: SnapCandidate = {
                    snapped_lat: mr.snapped_lat,
                    snapped_lon: mr.snapped_lon,
                    elevation_m: mr.elevation_m ?? 0,
                    snapped_distance_m: mr.snapped_distance_m ?? 0,
                    confidence: mr.ml_probability ?? 0,
                    radial_score: mr.ml_probability ?? 0,
                    neighborhood_score: mr.ml_probability ?? 0,
                    ml_probability: mr.ml_probability,
                };
                
                return {
                    peak_id: mr.peak_id,
                    candidates: [candidate],
                };
            });
        } else {
            // Heuristic snapping (existing behavior)
            results = await runPythonSnap(pythonBin, pythonScript, demPath, inputs);
        }

        const byId = new Map<string, SnapResult>();
        for (const r of results) byId.set(r.peak_id, r);

        // Try fallback DEM for peaks that got errors (no_data, no_local_max)
        const usedFallbackDem = new Set<string>();
        if (demPathFallback) {
            const failedPeaks = inputs.filter((inp) => {
                const r = byId.get(inp.peak_id);
                return r?.error === "no_data" || r?.error === "no_local_max";
            });
            if (failedPeaks.length > 0) {
                console.log(`  Trying fallback DEM for ${failedPeaks.length} peaks with errors...`);
                
                let fallbackResults: SnapResult[];
                if (useMLSnapping) {
                    const mlFallbackInputs: MLSnapInput[] = failedPeaks.map((inp) => ({
                        peak_id: inp.peak_id,
                        lat: inp.lat,
                        lon: inp.lon,
                        radius_m: inp.radius_m,
                    }));
                    const mlFallbackRes = await runPythonMLSnap(pythonBin, mlScript, demPathFallback, mlModelPath, mlFallbackInputs);
                    fallbackResults = mlFallbackRes.map((mr) => {
                        if (mr.error || mr.snapped_lat === undefined || mr.snapped_lon === undefined) {
                            return { peak_id: mr.peak_id, error: mr.error ?? "ml_failed" };
                        }
                        return {
                            peak_id: mr.peak_id,
                            candidates: [{
                                snapped_lat: mr.snapped_lat,
                                snapped_lon: mr.snapped_lon,
                                elevation_m: mr.elevation_m ?? 0,
                                snapped_distance_m: mr.snapped_distance_m ?? 0,
                                confidence: mr.ml_probability ?? 0,
                                radial_score: mr.ml_probability ?? 0,
                                neighborhood_score: mr.ml_probability ?? 0,
                                ml_probability: mr.ml_probability,
                            }],
                        };
                    });
                } else {
                    fallbackResults = await runPythonSnap(pythonBin, pythonScript, demPathFallback, failedPeaks);
                }
                
                for (const fr of fallbackResults) {
                    // Only use fallback if it succeeded
                    if (!fr.error && fr.candidates && fr.candidates.length > 0) {
                        byId.set(fr.peak_id, fr);
                        usedFallbackDem.add(fr.peak_id);
                    }
                }
                console.log(`  Fallback succeeded for ${usedFallbackDem.size}/${failedPeaks.length} peaks`);
            }
        }

        let accepted = 0;
        let review = 0;
        let errors = skippedRows; // Start with skipped rows (null coordinates)
        let collisions = 0;
        let fallbackDemUsed = 0;

        // Process in same order (highest elevation first) - only process valid rows
        for (const row of validRows) {
            const r = byId.get(row.id);
            const usedFallback = usedFallbackDem.has(row.id);
            const fallbackTag = usedFallback ? " [FALLBACK DEM]" : "";
            
            if (!r || r.error) {
                errors += 1;
                console.log(
                    `  ❌ ${row.name}: ERROR ${r?.error ?? "unknown"}${fallbackTag}`
                );
                console.log(
                    `     seed=(${safeToFixed(row.lat, 6)}, ${safeToFixed(row.lon, 6)}) elev=${safeToFixed(row.elevation, 0)}m`
                );
                // Don't set coords_snapped_at on errors so the peak can be re-processed later
                continue;
            }

            const candidates = r.candidates ?? [];
            if (candidates.length === 0) {
                errors += 1;
                console.log(
                    `  ❌ ${row.name}: ERROR no_candidates${fallbackTag}`
                );
                console.log(
                    `     seed=(${safeToFixed(row.lat, 6)}, ${safeToFixed(row.lon, 6)}) elev=${safeToFixed(row.elevation, 0)}m`
                );
                // Don't set coords_snapped_at on errors so the peak can be re-processed later
                continue;
            }

            if (usedFallback) fallbackDemUsed += 1;

            // Find first unclaimed candidate (pass peakId to skip self-collision when reprocessing)
            const result = findFirstUnclaimedCandidate(candidates, claimedCoords, collisionRadiusM, row.id);
            if (!result) {
                errors += 1;
                console.log(
                    `  ❌ ${row.name}: ERROR all_candidates_invalid (${candidates.length} candidates all collided)${fallbackTag}`
                );
                console.log(
                    `     seed=(${safeToFixed(row.lat, 6)}, ${safeToFixed(row.lon, 6)}) elev=${safeToFixed(row.elevation, 0)}m`
                );
                continue;
            }

            const chosen = result.candidate;
            const dist = chosen.snapped_distance_m;
            const confidence = chosen.confidence ?? 1.0;
            const radialScore = chosen.radial_score ?? 1.0;
            const neighborhoodScore = chosen.neighborhood_score ?? 1.0;
            
            // Accept if: within distance, no collision, AND good confidence
            const shouldAccept = dist <= acceptMaxDistance && 
                                 !result.collidedWith && 
                                 confidence >= confidenceAcceptMin;

            // Log collision details
            if (result.candidatesSkipped > 0) {
                collisions += result.candidatesSkipped;
                console.log(
                    `  ⚠️  ${row.name}: skipped ${result.candidatesSkipped} candidate(s) due to collisions:`
                );
                for (const skip of result.skippedCollisions) {
                    console.log(`     → collision with ${skip.peakId} (${skip.distM.toFixed(1)}m apart)`);
                }
            }
            
            if (result.collidedWith) {
                collisions += 1;
                console.log(
                    `  ⚠️  ${row.name}: ALL candidates collided! Best option collides with ${result.collidedWith} (${result.collisionDistM?.toFixed(1)}m apart)`
                );
            }

            // Format confidence info
            const confStr = `conf=${(confidence * 100).toFixed(0)}% (radial=${(radialScore * 100).toFixed(0)}%, nbhd=${(neighborhoodScore * 100).toFixed(0)}%)`;

            if (shouldAccept) {
                accepted += 1;
                console.log(
                    `  ✅ ${row.name}: ACCEPT dist=${dist.toFixed(1)}m elev=${chosen.elevation_m.toFixed(1)}m ${confStr}${fallbackTag}`
                );
                console.log(
                    `     seed=(${safeToFixed(row.lat, 6)}, ${safeToFixed(row.lon, 6)}) → snap=(${chosen.snapped_lat.toFixed(6)}, ${chosen.snapped_lon.toFixed(6)})`
                );

                // Mark as claimed
                claimedCoords.push({ lat: chosen.snapped_lat, lon: chosen.snapped_lon, peakId: row.id });

                const snappedPointGeom = "ST_SetSRID(ST_MakePoint($1, $2), 4326)";
                const setLocationGeomSql = includeLocationGeom
                    ? `, location_geom = ${snappedPointGeom}`
                    : "";
                const resetPublicLandsSql =
                    hasPublicLandsChecked && hasPeaksPublicLands
                        ? `, public_lands_checked = FALSE`
                        : "";
                if (!dryRun) {
                    await pool.query(
                        `
                        UPDATE peaks
                        SET snapped_coords = ${snappedPointGeom},
                            snapped_distance_m = $3,
                            snapped_dem_source = $4,
                            snapped_elevation_m = $5,
                            coords_snapped_at = NOW(),
                            needs_review = FALSE,
                            location_coords = (${snappedPointGeom})::geography
                            ${setLocationGeomSql},
                            elevation = $5,
                            elevation_source = 'usgs_3dep'
                            ${resetPublicLandsSql}
                        WHERE id = $6
                    `,
                        [chosen.snapped_lon, chosen.snapped_lat, dist, "usgs_3dep_10m", chosen.elevation_m, row.id]
                    );

                    if (hasPeaksPublicLands) {
                        await pool.query(
                            `DELETE FROM peaks_public_lands WHERE peak_id = $1`,
                            [row.id]
                        );
                    }
                }
            } else {
                review += 1;
                // Determine review reason(s)
                const reasons: string[] = [];
                if (result.collidedWith) {
                    reasons.push(`collision with ${result.collidedWith}`);
                }
                if (dist > acceptMaxDistance) {
                    reasons.push(`dist ${dist.toFixed(1)}m > max ${acceptMaxDistance}m`);
                }
                if (confidence < confidenceAcceptMin) {
                    reasons.push(`low confidence ${(confidence * 100).toFixed(0)}% < ${(confidenceAcceptMin * 100).toFixed(0)}%`);
                }
                const reason = reasons.length > 0 ? reasons.join(", ") : "unknown";
                
                console.log(
                    `  🔍 ${row.name}: REVIEW (${reason}) elev=${chosen.elevation_m.toFixed(1)}m ${confStr}${fallbackTag}`
                );
                console.log(
                    `     seed=(${safeToFixed(row.lat, 6)}, ${safeToFixed(row.lon, 6)}) → snap=(${chosen.snapped_lat.toFixed(6)}, ${chosen.snapped_lon.toFixed(6)})`
                );

                // Still mark as claimed so lower peaks don't steal it
                claimedCoords.push({ lat: chosen.snapped_lat, lon: chosen.snapped_lon, peakId: row.id });

                if (!dryRun) {
                    await pool.query(
                        `
                        UPDATE peaks
                        SET snapped_coords = ST_SetSRID(ST_MakePoint($1, $2), 4326),
                            snapped_distance_m = $3,
                            snapped_dem_source = $4,
                            snapped_elevation_m = $5,
                            coords_snapped_at = NOW(),
                            needs_review = TRUE
                        WHERE id = $6
                    `,
                        [chosen.snapped_lon, chosen.snapped_lat, dist, "usgs_3dep_10m", chosen.elevation_m, row.id]
                    );
                }
            }
        }

        // Update global counters (count all rows, including skipped ones)
        totalProcessed += rows.length;
        totalAccepted += accepted;
        totalReview += review;
        totalErrors += errors;
        totalCollisions += collisions;
        totalFallbackUsed += fallbackDemUsed;

        // Track processed peaks for dry run mode
        for (const row of rows) {
            processedPeakIds.add(row.id);
        }

        console.log(`\n${"─".repeat(60)}`);
        console.log(
            `Batch ${batch} summary: ✅ accepted=${accepted} | 🔍 review=${review} | ❌ errors=${errors}`
        );
        if (collisions > 0) {
            console.log(`  Collisions encountered: ${collisions}`);
        }
        if (fallbackDemUsed > 0) {
            console.log(`  Used fallback DEM: ${fallbackDemUsed}`);
        }
        console.log(`  Total claimed coords: ${claimedCoords.length}`);

        if (peakIdsFilter.length > 0 || peakNameLike) {
            console.log("Targeted run complete; stopping after one batch.");
            break;
        }
    }

    // Final summary
    const totalElapsedSec = (Date.now() - startTime) / 1000;
    const totalElapsedStr = totalElapsedSec >= 60 
        ? `${Math.floor(totalElapsedSec / 60)}m ${Math.floor(totalElapsedSec % 60)}s`
        : `${totalElapsedSec.toFixed(1)}s`;
    const finalPeaksPerSec = totalProcessed > 0 ? (totalProcessed / totalElapsedSec).toFixed(2) : "0";

    console.log(`\n${"═".repeat(80)}`);
    console.log("SNAP-TO-HIGHEST COMPLETE");
    console.log(`${"═".repeat(80)}`);
    console.log(`Total peaks processed: ${totalProcessed} in ${totalElapsedStr} (${finalPeaksPerSec} peaks/sec)`);
    console.log(`  ✅ Accepted (auto-updated): ${totalAccepted}`);
    console.log(`  🔍 Review (needs manual check): ${totalReview}`);
    console.log(`  ❌ Errors (not snapped): ${totalErrors}`);
    if (totalCollisions > 0) {
        console.log(`  ⚠️  Collision events: ${totalCollisions}`);
    }
    if (totalFallbackUsed > 0) {
        console.log(`  📍 Used fallback DEM: ${totalFallbackUsed}`);
    }
    console.log(`\nTotal claimed coordinates: ${claimedCoords.length}`);
    if (dryRun) {
        console.log(`\n⚠️  DRY RUN - no changes were written to the database`);
    }
}
