import { config } from "dotenv";
config();

import { Pool } from "pg";
import { spawn } from "child_process";
import getCloudSqlConnection from "./getCloudSqlConnection";

type PeakRow = {
    id: string;
    name: string;
    lat: number;
    lon: number;
    elevation: number | null;
};

type ZoneResult = {
    peak_id: string;
    zone_wkt?: string;
    area_sq_m?: number;
    max_elevation_m?: number;
    threshold_m?: number;
    vertices?: number;
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

const runPythonZoneExtractor = async (
    pythonBin: string,
    scriptPath: string,
    demPath: string,
    inputs: { peak_id: string; lat: number; lon: number; radius_m: number; threshold_m: number }[]
): Promise<ZoneResult[]> => {
    return await new Promise((resolve, reject) => {
        const child = spawn(pythonBin, [scriptPath, "--dem", demPath], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        const out: ZoneResult[] = [];
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
                    out.push(JSON.parse(line) as ZoneResult);
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

const formatArea = (areaSqM: number): string => {
    if (areaSqM < 1) {
        return `${areaSqM.toFixed(2)} sq m`;
    } else if (areaSqM < 1000) {
        return `${areaSqM.toFixed(0)} sq m`;
    } else {
        return `${(areaSqM / 1000).toFixed(1)}k sq m`;
    }
};

const metersToFeet = (m: number): number => m * 3.28084;

export default async function computeSummitZones(): Promise<void> {
    const pool = await getCloudSqlConnection();

    const demPath = process.env.DEM_VRT_PATH;
    if (!demPath) {
        throw new Error("DEM_VRT_PATH is required (path to DEM VRT/GeoTIFF)");
    }

    const pythonBin = process.env.PYTHON_BIN ?? "python3";
    const pythonScript = process.env.ZONE_PY_SCRIPT ?? "python/extract_summit_zone.py";

    const thresholdM = Number.parseFloat(process.env.ZONE_THRESHOLD_M ?? "5");
    const radiusM = Number.parseFloat(process.env.ZONE_RADIUS_M ?? "250");
    const batchSize = Number.parseInt(process.env.ZONE_BATCH_SIZE ?? "100", 10);
    const maxBatches = process.env.ZONE_MAX_BATCHES ? Number.parseInt(process.env.ZONE_MAX_BATCHES, 10) : undefined;
    const dryRun = process.env.ZONE_DRY_RUN !== "false";

    const states = (process.env.ZONE_STATES ?? "CO,NH,CA")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const peakNameLike = (process.env.ZONE_PEAK_NAME_ILIKE ?? "").trim();
    const peakIdsFilter = (process.env.ZONE_PEAK_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const includeLocationGeom = await hasColumn(pool, "peaks", "location_geom");
    const hasSummitZoneGeom = await hasColumn(pool, "peaks", "summit_zone_geom");
    const coordExpr = includeLocationGeom ? "location_geom" : "location_coords::geometry";

    console.log("\n" + "═".repeat(80));
    console.log("COMPUTE SUMMIT ZONES - Node orchestrator + Python rasterio");
    console.log("═".repeat(80));
    console.log(`Threshold (vertical m): ${thresholdM}`);
    console.log(`Search radius (m): ${radiusM}`);
    console.log(`Batch size: ${batchSize}`);
    console.log(`States: ${states.join(", ")}`);
    console.log(`DEM: ${demPath}`);
    console.log(`Dry run (no DB writes): ${dryRun ? "YES" : "NO"}`);
    if (peakNameLike) {
        console.log(`Peak name filter (ILIKE): ${peakNameLike}`);
    }
    if (peakIdsFilter.length > 0) {
        console.log(`Peak ID filter: ${peakIdsFilter.length} ids`);
    }
    if (!hasSummitZoneGeom) {
        console.log(`Note: summit_zone_geom column does not exist (run SQL migration first for write mode)`);
    }

    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalErrors = 0;
    let batch = 0;

    while (true) {
        batch += 1;
        if (maxBatches && batch > maxBatches) {
            console.log(`\nReached ZONE_MAX_BATCHES=${maxBatches}; stopping.`);
            break;
        }

        const whereParts: string[] = [];
        const params: any[] = [];

        // Filter by states
        if (states.length > 0) {
            params.push(states);
            whereParts.push(`p.state = ANY($${params.length}::varchar[])`);
        }

        // Only peaks that have been snapped (have DEM coverage)
        whereParts.push(`p.coords_snapped_at IS NOT NULL`);

        // Skip peaks that already have a summit zone (unless in dry-run or targeted mode)
        if (!dryRun && hasSummitZoneGeom && !peakNameLike && peakIdsFilter.length === 0) {
            whereParts.push(`p.summit_zone_geom IS NULL`);
        }

        // Optional filters
        if (peakNameLike) {
            params.push(peakNameLike);
            whereParts.push(`p.name ILIKE $${params.length}`);
        }
        if (peakIdsFilter.length > 0) {
            params.push(peakIdsFilter);
            whereParts.push(`p.id = ANY($${params.length}::varchar[])`);
        }

        params.push(batchSize);
        const limitParam = `$${params.length}`;

        const { rows } = await pool.query<PeakRow>(
            `
            SELECT
                p.id,
                p.name,
                ST_Y(${coordExpr}) AS lat,
                ST_X(${coordExpr}) AS lon,
                p.elevation
            FROM peaks p
            WHERE ${whereParts.join("\n              AND ")}
            ORDER BY p.elevation DESC NULLS LAST
            LIMIT ${limitParam}
        `,
            params
        );

        if (rows.length === 0) {
            if (batch === 1) {
                console.log("\nNo peaks found matching criteria.");
            } else {
                console.log("\nNo more peaks to process.");
            }
            break;
        }

        const inputs = rows.map((r) => ({
            peak_id: r.id,
            lat: r.lat,
            lon: r.lon,
            radius_m: radiusM,
            threshold_m: thresholdM,
        }));

        console.log(`\n${"─".repeat(60)}`);
        console.log(`Batch ${batch}: computing zones for ${inputs.length} peaks...`);
        console.log(`${"─".repeat(60)}`);

        const results = await runPythonZoneExtractor(pythonBin, pythonScript, demPath, inputs);

        const byId = new Map<string, ZoneResult>();
        for (const r of results) byId.set(r.peak_id, r);

        for (const row of rows) {
            totalProcessed += 1;
            const r = byId.get(row.id);

            if (!r || r.error) {
                totalErrors += 1;
                console.log(`\n  ${row.name} (${row.id})`);
                console.log(`    ERROR: ${r?.error ?? "unknown"}`);
                continue;
            }

            totalSuccess += 1;

            const elevFt = row.elevation ? Math.round(metersToFeet(row.elevation)) : null;
            const maxElevFt = r.max_elevation_m ? Math.round(metersToFeet(r.max_elevation_m)) : null;

            console.log(`\n  ${row.name}${elevFt ? ` (${elevFt.toLocaleString()} ft)` : ""}`);
            console.log(`    Zone area: ${formatArea(r.area_sq_m ?? 0)}`);
            console.log(`    Vertices: ${r.vertices ?? 0}`);
            console.log(`    Max elevation: ${maxElevFt ? `${maxElevFt.toLocaleString()} ft` : "N/A"} (DEM)`);
            console.log(`    Threshold: ${r.threshold_m ?? thresholdM}m`);

            // Classify the summit type based on area
            const area = r.area_sq_m ?? 0;
            let summitType: string;
            if (area < 50) {
                summitType = "knife-edge / point summit";
            } else if (area < 200) {
                summitType = "small summit area";
            } else if (area < 1000) {
                summitType = "moderate summit plateau";
            } else {
                summitType = "large / flat summit";
            }
            console.log(`    Classification: ${summitType}`);

            // In write mode, store the zone geometry
            if (!dryRun && hasSummitZoneGeom && r.zone_wkt) {
                await pool.query(
                    `
                    UPDATE peaks
                    SET summit_zone_geom = ST_GeomFromText($1, 4326),
                        summit_zone_threshold_m = $2
                    WHERE id = $3
                `,
                    [r.zone_wkt, r.threshold_m ?? thresholdM, row.id]
                );
            }
        }

        // If targeting specific peaks, stop after one batch
        if (peakNameLike || peakIdsFilter.length > 0) {
            console.log("\nTargeted run complete; stopping after one batch.");
            break;
        }
    }

    console.log("\n" + "═".repeat(80));
    console.log("SUMMARY");
    console.log("═".repeat(80));
    console.log(`Total processed: ${totalProcessed}`);
    console.log(`Success: ${totalSuccess}`);
    console.log(`Errors: ${totalErrors}`);
    if (dryRun) {
        console.log(`\nDry run complete. To write zones to DB, run with ZONE_DRY_RUN=false`);
    }
}

