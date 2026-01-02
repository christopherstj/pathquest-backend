import { config } from "dotenv";
config();

import { Pool } from "pg";
import { spawn } from "child_process";
import getCloudSqlConnection from "./getCloudSqlConnection";

type PeakSeedRow = {
    id: string;
    lat: number;
    lon: number;
    source_origin: string | null;
};

type SnapResult = {
    peak_id: string;
    snapped_lat?: number;
    snapped_lon?: number;
    elevation_m?: number;
    snapped_distance_m?: number;
    error?: string;
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
    inputs: { peak_id: string; lat: number; lon: number; radius_m: number }[]
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

export default async function snapPeaksToHighest3dep(): Promise<void> {
    const pool = await getCloudSqlConnection();

    const demPath = process.env.DEM_VRT_PATH;
    if (!demPath) {
        throw new Error("DEM_VRT_PATH is required (path to Colorado 3DEP VRT/GeoTIFF)");
    }

    const pythonBin = process.env.PYTHON_BIN ?? "python3";
    const pythonScript = process.env.SNAP_PY_SCRIPT ?? "python/snap_to_highest.py";

    const state = process.env.SNAP_STATE ?? "CO";
    const elevationMin = Number.parseFloat(process.env.SNAP_ELEVATION_MIN_M ?? "3962"); // ~13,000 ft
    const batchSize = Number.parseInt(process.env.SNAP_BATCH_SIZE ?? "500", 10);
    const maxBatches = process.env.SNAP_MAX_BATCHES ? Number.parseInt(process.env.SNAP_MAX_BATCHES, 10) : undefined;
    const acceptMaxDistance = Number.parseFloat(process.env.SNAP_ACCEPT_MAX_DISTANCE_M ?? "300");

    const radiusOsm = Number.parseFloat(process.env.SNAP_RADIUS_OSM_M ?? "250");
    const radiusPeakbagger = Number.parseFloat(process.env.SNAP_RADIUS_PEAKBAGGER_M ?? "150");

    const includeLocationGeom = await hasColumn(pool, "peaks", "location_geom");
    const seedExpr = "COALESCE(seed_coords, " + (includeLocationGeom ? "location_geom" : "location_coords::geometry") + ")";
    const hasPublicLandsChecked = await hasColumn(pool, "peaks", "public_lands_checked");
    const hasPeaksPublicLands = await hasTable(pool, "peaks_public_lands");

    console.log("\n" + "═".repeat(80));
    console.log("SNAP-TO-HIGHEST (3DEP) - Node orchestrator + Python rasterio");
    console.log("═".repeat(80));
    console.log(`State: ${state}`);
    console.log(`Elevation min (m): ${elevationMin}`);
    console.log(`Batch size: ${batchSize}`);
    console.log(`Accept max distance (m): ${acceptMaxDistance}`);
    console.log(`DEM: ${demPath}`);
    if (hasPublicLandsChecked && hasPeaksPublicLands) {
        console.log(`Public lands reset-on-accept: ENABLED`);
    } else {
        console.log(`Public lands reset-on-accept: DISABLED (missing public_lands_checked and/or peaks_public_lands)`);
    }

    let batch = 0;
    while (true) {
        batch += 1;
        if (maxBatches && batch > maxBatches) {
            console.log(`Reached SNAP_MAX_BATCHES=${maxBatches}; stopping.`);
            break;
        }

        const { rows } = await pool.query<PeakSeedRow>(
            `
            SELECT
                p.id,
                ST_Y(${seedExpr}) AS lat,
                ST_X(${seedExpr}) AS lon,
                p.source_origin
            FROM peaks p
            WHERE p.state = $1
              AND (
                    (p.elevation IS NOT NULL AND p.elevation >= $2)
                 OR EXISTS (
                    SELECT 1
                    FROM peak_external_ids pei
                    WHERE pei.peak_id = p.id
                      AND pei.source = 'peakbagger'
                 )
              )
              AND (p.coords_snapped_at IS NULL)
            LIMIT $3
        `,
            [state, elevationMin, batchSize]
        );

        if (rows.length === 0) {
            console.log("No more peaks to snap.");
            break;
        }

        const inputs = rows.map((r) => ({
            peak_id: r.id,
            lat: r.lat,
            lon: r.lon,
            radius_m: r.source_origin === "peakbagger" ? radiusPeakbagger : radiusOsm,
        }));

        console.log(`\nBatch ${batch}: snapping ${inputs.length} peaks...`);
        const results = await runPythonSnap(pythonBin, pythonScript, demPath, inputs);

        const byId = new Map<string, SnapResult>();
        for (const r of results) byId.set(r.peak_id, r);

        let accepted = 0;
        let review = 0;
        let errors = 0;

        for (const row of rows) {
            const r = byId.get(row.id);
            if (!r || r.error) {
                errors += 1;
                await pool.query(
                    `
                    UPDATE peaks
                    SET snapped_coords = NULL,
                        snapped_distance_m = NULL,
                        snapped_dem_source = $1,
                        coords_snapped_at = NOW(),
                        needs_review = TRUE
                    WHERE id = $2
                `,
                    ["usgs_3dep_10m", row.id]
                );
                continue;
            }

            const dist = r.snapped_distance_m ?? Number.POSITIVE_INFINITY;
            const shouldAccept = dist <= acceptMaxDistance;

            if (shouldAccept) {
                accepted += 1;
                const snappedPointGeom = "ST_SetSRID(ST_MakePoint($1, $2), 4326)";
                const setLocationGeomSql = includeLocationGeom
                    ? `, location_geom = ${snappedPointGeom}`
                    : "";
                const resetPublicLandsSql =
                    hasPublicLandsChecked && hasPeaksPublicLands
                        ? `, public_lands_checked = FALSE`
                        : "";
                await pool.query(
                    `
                    UPDATE peaks
                    SET snapped_coords = ${snappedPointGeom},
                        snapped_distance_m = $3,
                        snapped_dem_source = $4,
                        coords_snapped_at = NOW(),
                        needs_review = FALSE,
                        location_coords = (${snappedPointGeom})::geography
                        ${setLocationGeomSql},
                        elevation = $5,
                        elevation_source = 'usgs_3dep'
                        ${resetPublicLandsSql}
                    WHERE id = $6
                `,
                    [r.snapped_lon, r.snapped_lat, dist, "usgs_3dep_10m", r.elevation_m ?? null, row.id]
                );

                if (hasPeaksPublicLands) {
                    await pool.query(
                        `DELETE FROM peaks_public_lands WHERE peak_id = $1`,
                        [row.id]
                    );
                }
            } else {
                review += 1;
                await pool.query(
                    `
                    UPDATE peaks
                    SET snapped_coords = ST_SetSRID(ST_MakePoint($1, $2), 4326),
                        snapped_distance_m = $3,
                        snapped_dem_source = $4,
                        coords_snapped_at = NOW(),
                        needs_review = TRUE
                    WHERE id = $5
                `,
                    [r.snapped_lon, r.snapped_lat, dist, "usgs_3dep_10m", row.id]
                );
            }
        }

        console.log(
            `Batch ${batch} results: accepted=${accepted} review=${review} errors=${errors}`
        );
    }
}


