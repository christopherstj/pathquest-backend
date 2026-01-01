import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as shapefile from "shapefile";
import AdmZip from "adm-zip";
import getCloudSqlConnection from "./getCloudSqlConnection";

const execAsync = promisify(exec);
const DATA_DIR = path.join(__dirname, "..", "geodata");

/**
 * PAD-US (Protected Areas Database of the United States) import.
 * 
 * Supports both GDB (File Geodatabase) and Shapefile formats.
 * GDB is preferred - uses ogr2ogr for direct PostGIS import.
 * 
 * Download from:
 * - https://www.protectedlands.net/how-to-get-pad-us/
 * - https://www.sciencebase.gov/catalog/item/652ef930d34e44f4e2189e0e
 * 
 * Place the downloaded file/folder in:
 * pathquest-backend/data-backup/geodata/padus/
 * 
 * For GDB: Place the .gdb folder (e.g., PADUS4_0_Geodatabase.gdb/)
 * For Shapefile: Place the .shp and related files
 * 
 * Requires GDAL/ogr2ogr for GDB format:
 * - Windows: choco install gdal OR OSGeo4W installer
 * - Mac: brew install gdal
 * - Linux: apt install gdal-bin
 * 
 * Stores geometry as GEOMETRY (not GEOGRAPHY) for fast indexed spatial joins.
 */

// PAD-US designation types we care about (for display)
const DESIGNATION_TYPES = new Set([
    "NP",    // National Park
    "NM",    // National Monument  
    "NF",    // National Forest
    "NG",    // National Grassland
    "NWR",   // National Wildlife Refuge
    "WILD",  // Wilderness Area
    "WSA",   // Wilderness Study Area
    "NRA",   // National Recreation Area
    "NCA",   // National Conservation Area
    "SP",    // State Park
    "SF",    // State Forest
    "SW",    // State Wilderness
    "SRA",   // State Recreation Area
]);

const BATCH_SIZE = 500;

// Sanitize string to remove null bytes and invalid UTF-8
const sanitizeString = (value: any): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") return String(value);
    return value.replace(/\x00/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim() || null;
};

// Convert GeoJSON geometry to WKT format for PostGIS
const geometryToWKT = (geometry: any): string => {
    const type = geometry.type;
    const coords = geometry.coordinates;

    const formatRing = (ring: number[][]) =>
        ring.map((pt) => `${pt[0]} ${pt[1]}`).join(", ");

    const formatPolygon = (polygon: number[][][]) =>
        `(${polygon.map((ring) => `(${formatRing(ring)})`).join(", ")})`;

    if (type === "Polygon") {
        return `POLYGON${formatPolygon(coords)}`;
    } else if (type === "MultiPolygon") {
        const polygons = coords.map((poly: number[][][]) => formatPolygon(poly)).join(", ");
        return `MULTIPOLYGON(${polygons})`;
    } else {
        return "";
    }
};

const importPublicLands = async () => {
    const pool = await getCloudSqlConnection();
    
    console.log("=== Importing US Public Lands (PAD-US) ===\n");
    
    // Check if PAD-US data exists
    const padusDir = path.join(DATA_DIR, "padus");
    
    if (!fs.existsSync(padusDir)) {
        console.log(`
PAD-US data not found at: ${padusDir}

Please download PAD-US data manually:

1. Go to: https://www.protectedlands.net/how-to-get-pad-us/
   Or: https://www.sciencebase.gov/catalog/item/652ef930d34e44f4e2189e0e
2. Download PAD-US (GDB preferred, or Shapefile)
3. Extract to: ${padusDir}
4. Run this script again
`);
        return;
    }
    
    // Find GDB, Shapefile, or ZIP to extract
    const findDataFile = (dir: string): { type: "gdb" | "shp" | "zip"; path: string } | null => {
        const files = fs.readdirSync(dir);
        
        // Look for .gdb folder first (preferred)
        const gdbFolder = files.find((f) => f.endsWith(".gdb") && fs.statSync(path.join(dir, f)).isDirectory());
        if (gdbFolder) {
            return { type: "gdb", path: path.join(dir, gdbFolder) };
        }
        
        // Look for ZIP file (will extract)
        const zipFile = files.find((f) => f.toLowerCase().endsWith(".zip") && f.toLowerCase().includes("padus"));
        if (zipFile) {
            return { type: "zip", path: path.join(dir, zipFile) };
        }
        
        // Look for shapefile
        let shp = files.find((f) => f.endsWith(".shp") && f.toLowerCase().includes("fee"));
        if (!shp) {
            shp = files.find((f) => f.endsWith(".shp"));
        }
        if (shp) {
            return { type: "shp", path: path.join(dir, shp) };
        }
        
        // Check subdirectories
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory() && !file.endsWith(".gdb")) {
                const found = findDataFile(fullPath);
                if (found) return found;
            }
        }
        return null;
    };
    
    let dataFile = findDataFile(padusDir);
    
    if (!dataFile) {
        console.error(`No GDB, Shapefile, or ZIP found in ${padusDir}`);
        console.error("Expected: .gdb folder, .shp file, or PADUS*.zip");
        console.log("Contents:", fs.readdirSync(padusDir));
        return;
    }
    
    // Extract ZIP if needed
    if (dataFile.type === "zip") {
        console.log(`Found ZIP: ${path.basename(dataFile.path)}`);
        
        const extractDir = path.join(padusDir, "extracted");
        
        // Check if already extracted
        if (fs.existsSync(extractDir)) {
            const existingGdb = findDataFile(extractDir);
            if (existingGdb && existingGdb.type === "gdb") {
                console.log("  ✓ Already extracted, skipping extraction");
                dataFile = existingGdb;
            } else {
                // Extract dir exists but no GDB found, re-extract
                console.log("Extracting (this may take a few minutes for large files)...");
                const zip = new AdmZip(dataFile.path);
                zip.extractAllTo(extractDir, true);
                console.log("  ✓ Extraction complete");
                dataFile = findDataFile(extractDir);
            }
        } else {
            // No extract dir, extract fresh
            console.log("Extracting (this may take a few minutes for large files)...");
            fs.mkdirSync(extractDir, { recursive: true });
            const zip = new AdmZip(dataFile.path);
            zip.extractAllTo(extractDir, true);
            console.log("  ✓ Extraction complete");
            dataFile = findDataFile(extractDir);
        }
        
        if (!dataFile || dataFile.type === "zip") {
            console.error("Could not find .gdb folder in extracted ZIP");
            console.log("Extracted contents:", fs.readdirSync(extractDir));
            return;
        }
    }
    
    console.log(`Found ${dataFile.type.toUpperCase()}: ${path.basename(dataFile.path)}`);
    
    // Route to appropriate import method
    if (dataFile.type === "gdb") {
        await importFromGDB(pool, dataFile.path);
    } else {
        await importFromShapefile(pool, dataFile.path);
    }
};

/**
 * Import from Esri File Geodatabase using ogr2ogr
 */
const importFromGDB = async (pool: any, gdbPath: string) => {
    console.log("\n[1/4] Creating public_lands table...");
    
    await pool.query(`
        DROP TABLE IF EXISTS public_lands CASCADE;
        DROP TABLE IF EXISTS padus_raw CASCADE;
    `);
    
    console.log("  ✓ Dropped existing tables");
    
    // Get connection details
    const host = process.env.PG_HOST ?? "127.0.0.1";
    const port = process.env.PG_PORT ?? "5432";
    const user = process.env.PG_USER ?? "local-user";
    const password = process.env.PG_PASSWORD ?? process.env.MYSQL_PASSWORD ?? "";
    const database = process.env.PG_DATABASE ?? "operations";
    
    // List layers in the GDB
    console.log("\n[2/4] Discovering layers in GDB...");
    const layers: Array<{ name: string; geomType: string | null }> = [];
    try {
        const { stdout } = await execAsync(`ogrinfo -so "${gdbPath}"`, { maxBuffer: 1024 * 1024 * 10 });
        console.log("  Layers found:");
        // Example lines:
        //   Layer: SomeLayer (Multi Polygon)
        //   Layer: SomeLookupTable (None)
        const layerLines = stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.startsWith("Layer: "));

        for (const l of layerLines) {
            const m = /^Layer:\s*(.+?)\s*\((.+?)\)\s*$/.exec(l);
            if (!m) continue;
            layers.push({ name: m[1], geomType: m[2] });
        }

        // Print a short preview
        layerLines.slice(0, 10).forEach((l) => console.log("    " + l));
        if (layerLines.length > 10) console.log(`    ... and ${layerLines.length - 10} more`);
    } catch (error: any) {
        console.error("Error listing GDB layers. Is GDAL/ogr2ogr installed?");
        console.error("Install with: choco install gdal (Windows) or brew install gdal (Mac)");
        throw error;
    }
    
    // Select layer to import.
    // PAD-US GDB versions vary: sometimes there's a Fee layer, sometimes a Combined layer.
    // Allow explicit override via env var.
    const requestedLayer = process.env.PADUS_GDB_LAYER;
    let selectedLayer: string | null = null;

    if (requestedLayer) {
        selectedLayer = requestedLayer;
        console.log(`\nUsing PADUS_GDB_LAYER override: ${selectedLayer}`);
    } else {
        // Heuristic:
        // 1) Prefer polygon layers that look like the dedicated Fee layer (e.g., PADUS4_1Fee)
        // 2) Else prefer polygon layers whose name includes "Fee" but not "Combined"/lookup tables
        // 3) Else prefer polygon layers whose name includes "Combined"
        // 4) Else first polygon layer found
        const polygonLayers = layers
            .filter((l) => l.geomType && l.geomType.toLowerCase().includes("polygon"))
            .map((l) => l.name);

        selectedLayer =
            polygonLayers.find((n) => /fee$/i.test(n) || /^padus.*fee$/i.test(n)) ??
            polygonLayers.find((n) => /fee/i.test(n) && !/combined|category|type|status|name|access/i.test(n)) ??
            polygonLayers.find((n) => /combined/i.test(n)) ??
            polygonLayers[0] ??
            null;
    }

    if (!selectedLayer) {
        throw new Error(
            `No polygon layers found in GDB. Try setting PADUS_GDB_LAYER to a layer name from ogrinfo output.`
        );
    }

    // Verify selected layer exists
    try {
        await execAsync(`ogrinfo -so "${gdbPath}" "${selectedLayer}"`, { maxBuffer: 1024 * 1024 });
    } catch (error: any) {
        throw new Error(
            `Selected layer "${selectedLayer}" not found. Set PADUS_GDB_LAYER to a valid layer name.`
        );
    }
    
    console.log(`\n[3/4] Importing layer "${selectedLayer}" (this may take several minutes)...`);
    
    // Import to PostGIS using ogr2ogr
    // -nlt PROMOTE_TO_MULTI handles mixed Polygon/MultiPolygon
    // -lco GEOMETRY_NAME=geom sets the geometry column name
    const pgConn = `PG:host=${host} port=${port} user=${user} password=${password} dbname=${database}`;

    // Speed knobs (all optional):
    // - PADUS_OGR_WHERE: OGR SQL WHERE clause pushed down to GDAL (reduces rows imported)
    // - PADUS_OGR_SELECT: comma-separated list of columns to import (reduces width)
    // - PADUS_OGR_GT: features per transaction (reduces commit overhead); default 65536
    const whereClause = process.env.PADUS_OGR_WHERE?.trim();
    const selectCols = process.env.PADUS_OGR_SELECT?.trim();
    const gt = parseInt(process.env.PADUS_OGR_GT || "65536", 10);

    // Optional limit for testing (PADUS_OGR_LIMIT)
    const limit = parseInt(process.env.PADUS_OGR_LIMIT || "0", 10);

    // Log what optimizations are being used
    console.log("  Settings:");
    console.log(`    PG_USE_COPY: YES`);
    console.log(`    Transaction size: ${gt.toLocaleString()}`);
    console.log(`    WHERE: ${whereClause || "(none)"}`);
    console.log(`    SELECT: ${selectCols || "(all columns)"}`);
    if (limit > 0) {
        console.log(`    LIMIT: ${limit.toLocaleString()} features (test mode)`);
    }

    // Build command
    const whereArg = whereClause ? ` -where "${whereClause.replace(/"/g, '\\"')}"` : "";
    const selectArg = selectCols ? ` -select "${selectCols.replace(/"/g, '\\"')}"` : "";
    const limitArg = limit > 0 ? ` -limit ${limit}` : "";

    const importCmd =
        `ogr2ogr --config PG_USE_COPY YES` +
        ` -overwrite -f "PostgreSQL" "${pgConn}" "${gdbPath}" "${selectedLayer}"` +
        ` -nln public_lands -nlt PROMOTE_TO_MULTI -lco GEOMETRY_NAME=geom -t_srs EPSG:4326` +
        ` -gt ${Number.isFinite(gt) && gt > 0 ? gt : 65536}` +
        ` -lco SPATIAL_INDEX=NONE` +
        whereArg +
        selectArg +
        limitArg;
    
    const startTime = Date.now();
    console.log("\n  Starting import...");
    
    try {
        const { stdout, stderr } = await execAsync(importCmd, { maxBuffer: 1024 * 1024 * 500 });
        if (stdout) console.log(stdout);
        if (stderr && !stderr.includes("Warning")) console.log(stderr);
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  ✓ Import complete in ${elapsed}s`);
    } catch (error: any) {
        console.error("Error importing GDB:", error.message);
        throw error;
    }
    
    // Get count
    const countResult = await pool.query(`SELECT COUNT(*) as count FROM public_lands`);
    console.log(`  ✓ Imported ${parseInt(countResult.rows[0].count).toLocaleString()} features`);
    
    // Create spatial index
    console.log("\n[4/4] Creating spatial index...");
    
    // Ensure geometry column is GEOMETRY type (ogr2ogr should do this, but verify)
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_public_lands_geom ON public_lands USING GIST(geom);
        ANALYZE public_lands;
    `);
    console.log("  ✓ Created spatial index");
    
    // Show summary
    await showSummary(pool);
};

/**
 * Import from Shapefile using Node.js shapefile library
 */
const importFromShapefile = async (pool: any, shpPath: string) => {
    
    // Create the public_lands table with GEOMETRY (not GEOGRAPHY) for fast indexed joins
    console.log("\n[1/3] Creating public_lands table...");
    
    await pool.query(`
        DROP TABLE IF EXISTS public_lands CASCADE;
        
        CREATE TABLE public_lands (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255),
            designation_type VARCHAR(50),
            designation_name VARCHAR(255),
            manager_type VARCHAR(50),
            manager_name VARCHAR(255),
            access_type VARCHAR(50),
            gis_acres NUMERIC,
            state VARCHAR(10),
            geom GEOMETRY(Geometry, 4326)
        );
    `);
    
    console.log("  ✓ Created public_lands table");
    
    // Import shapefile using Node.js parser
    console.log("\n[2/3] Importing PAD-US shapefile (this may take several minutes)...");
    
    const dbfPath = shpPath.replace(/\.shp$/i, ".dbf");
    const source = await shapefile.open(shpPath, dbfPath, { encoding: "UTF-8" });
    
    let batch: any[] = [];
    let total = 0;
    let inserted = 0;
    let skipped = 0;
    
    const flushBatch = async () => {
        if (batch.length === 0) return;

        const placeholders: string[] = [];
        const values: any[] = [];

        for (const feature of batch) {
            const props = feature.properties || {};
            const geom = feature.geometry;
            const wkt = geometryToWKT(geom);

            if (!wkt) {
                skipped++;
                continue;
            }
            
            // Get designation type (case-insensitive lookup)
            const desType = sanitizeString(
                props.Des_Tp || props.DES_TP || props.des_tp || props.Desig_Tp || null
            );
            const gisAcres = props.GIS_Acres || props.gis_acres || props.Shape_Area ? 
                (props.GIS_Acres || props.gis_acres || (props.Shape_Area / 4046.86)) : null;
            
            // Filter: only include designated types or large areas (>1000 acres)
            if (!DESIGNATION_TYPES.has(desType || "") && (gisAcres === null || gisAcres < 1000)) {
                skipped++;
                continue;
            }

            const base = values.length;
            placeholders.push(
                `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, ST_GeomFromText($${base + 9}, 4326))`
            );

            values.push(
                sanitizeString(props.Unit_Nm || props.unit_nm || props.Own_Name || props.own_name || null),
                desType,
                sanitizeString(props.Loc_Ds || props.loc_ds || props.Loc_Nm || props.loc_nm || null),
                sanitizeString(props.Mang_Type || props.mang_type || props.Own_Type || props.own_type || null),
                sanitizeString(props.Mang_Name || props.mang_name || props.Own_Name || props.own_name || null),
                sanitizeString(props.Pub_Access || props.pub_access || props.Access || props.access || null),
                gisAcres,
                sanitizeString(props.State_Nm || props.state_nm || null),
                wkt
            );
            inserted++;
        }

        if (placeholders.length > 0) {
            const sql = `
                INSERT INTO public_lands (name, designation_type, designation_name, manager_type, manager_name, access_type, gis_acres, state, geom)
                VALUES ${placeholders.join(", ")}
            `;
            await pool.query(sql, values);
        }

        batch = [];
    };

    let result = await source.read();
    while (!result.done) {
        batch.push(result.value);
        total++;

        if (batch.length >= BATCH_SIZE) {
            await flushBatch();
            if (total % 10000 === 0) {
                process.stdout.write(`\r  Processed ${total.toLocaleString()} features, inserted ${inserted.toLocaleString()}...`);
            }
        }

        result = await source.read();
    }

    // Flush remaining
    await flushBatch();
    console.log(`\r  ✓ Processed ${total.toLocaleString()} features total`);
    console.log(`  ✓ Inserted ${inserted.toLocaleString()} public land areas`);
    console.log(`  ✓ Skipped ${skipped.toLocaleString()} (not matching designation types or <1000 acres)`);
    
    // Create spatial index
    console.log("\n[3/3] Creating spatial index...");
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_public_lands_geom ON public_lands USING GIST(geom);
        ANALYZE public_lands;
    `);
    console.log("  ✓ Created spatial index");
    
    // Show summary
    await showSummary(pool);
};

/**
 * Show import summary stats
 */
const showSummary = async (pool: any) => {
    // Get column info to see what we have
    const columns = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'public_lands'
    `);
    const colNames = columns.rows.map((r: any) => r.column_name.toLowerCase());
    
    // Try to get summary by designation type if available
    const desTypeCol = colNames.find((c: string) => 
        c === "des_tp" || c === "designation_type" || c === "desig_tp"
    );
    const acresCol = colNames.find((c: string) => 
        c === "gis_acres" || c === "shape_area"
    );
    
    console.log("\n=== Import Complete ===\n");
    
    if (desTypeCol) {
        const summary = await pool.query(`
            SELECT "${desTypeCol}" as des_type, COUNT(*) as count
            FROM public_lands
            WHERE "${desTypeCol}" IS NOT NULL
            GROUP BY "${desTypeCol}"
            ORDER BY count DESC
            LIMIT 15
        `);
        
        console.log("Public lands by designation type:");
        for (const row of summary.rows) {
            console.log(`  ${row.des_type || "Unknown"}: ${parseInt(row.count).toLocaleString()} areas`);
        }
    } else {
        const countResult = await pool.query(`SELECT COUNT(*) as count FROM public_lands`);
        console.log(`Total areas: ${parseInt(countResult.rows[0].count).toLocaleString()}`);
    }
    
    console.log("\nNext: Run enrichPeaksWithPublicLands() to tag peaks with their public land.");
};

export default importPublicLands;

