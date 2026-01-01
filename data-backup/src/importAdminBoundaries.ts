import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import * as shapefile from "shapefile";
import getCloudSqlConnection from "./getCloudSqlConnection";

const execAsync = promisify(exec);

// Data sources
const DOWNLOADS = {
    countries: {
        url: "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip",
        file: "ne_10m_admin_0_countries",
        table: "admin_countries",
        columns: {
            iso_a2: "VARCHAR(10)",      // Country code (US, CA, etc.)
            name: "VARCHAR(255)",        // Country name
            name_long: "VARCHAR(255)",   // Long name
        },
    },
    states: {
        url: "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip",
        file: "ne_10m_admin_1_states_provinces",
        table: "admin_states",
        columns: {
            iso_3166_2: "VARCHAR(10)",   // State code (US-CO, CA-BC, etc.)
            name: "VARCHAR(255)",         // State/province name
            postal: "VARCHAR(10)",        // Postal code (CO, BC, etc.)
            admin: "VARCHAR(255)",        // Admin name
            iso_a2: "VARCHAR(10)",        // Country code
        },
    },
    usCounties: {
        url: "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip",
        file: "cb_2023_us_county_500k",
        table: "admin_us_counties",
        columns: {
            name: "VARCHAR(255)",         // County name
            namelsad: "VARCHAR(255)",     // Full name with type (e.g., "Boulder County")
            stusps: "VARCHAR(5)",         // State postal code
            statefp: "VARCHAR(5)",        // State FIPS code
            countyfp: "VARCHAR(5)",       // County FIPS code
            geoid: "VARCHAR(10)",         // Full GEOID
        },
    },
};

const DATA_DIR = path.join(__dirname, "..", "geodata");
const BATCH_SIZE = 500;

const ensureDataDir = () => {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
};

const downloadFile = async (url: string, filename: string): Promise<string> => {
    const zipPath = path.join(DATA_DIR, `${filename}.zip`);

    if (fs.existsSync(zipPath)) {
        console.log(`  ${filename}.zip already exists, skipping download`);
        return zipPath;
    }

    console.log(`  Downloading ${filename}...`);

    // Use curl for downloading (available on Windows 10+)
    await execAsync(`curl -L -o "${zipPath}" "${url}"`, { maxBuffer: 1024 * 1024 * 100 });

    return zipPath;
};

const extractZip = async (zipPath: string, extractDir: string): Promise<void> => {
    console.log(`  Extracting ${path.basename(zipPath)}...`);

    // Use PowerShell's Expand-Archive
    await execAsync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`
    );
};

// Sanitize string to remove null bytes and invalid UTF-8
const sanitizeString = (value: any): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") return String(value);
    // Remove null bytes and other control characters
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
    } else if (type === "Point") {
        return `POINT(${coords[0]} ${coords[1]})`;
    } else {
        console.warn(`  Warning: Unsupported geometry type: ${type}`);
        return "";
    }
};

const importShapefile = async (
    shpPath: string,
    tableName: string,
    columnDefs: Record<string, string>
): Promise<void> => {
    const pool = await getCloudSqlConnection();

    console.log(`  Importing ${tableName}...`);

    // Drop table if exists
    await pool.query(`DROP TABLE IF EXISTS ${tableName} CASCADE`);

    // Create table with defined columns + geom
    const columnsSql = Object.entries(columnDefs)
        .map(([name, type]) => `${name} ${type}`)
        .join(", ");

    await pool.query(`
        CREATE TABLE ${tableName} (
            gid SERIAL PRIMARY KEY,
            ${columnsSql},
            geom GEOGRAPHY(Geometry, 4326)
        )
    `);

    // Read shapefile and insert features
    // Use UTF-8 encoding but handle invalid sequences
    const dbfPath = shpPath.replace(/\.shp$/i, ".dbf");
    const source = await shapefile.open(shpPath, dbfPath, { encoding: "UTF-8" });
    let batch: any[] = [];
    let total = 0;

    const columnNames = Object.keys(columnDefs);

    const flushBatch = async () => {
        if (batch.length === 0) return;

        const placeholders: string[] = [];
        const values: any[] = [];

        for (const feature of batch) {
            const props = feature.properties || {};
            const geom = feature.geometry;
            const wkt = geometryToWKT(geom);

            if (!wkt) continue;

            const base = values.length;
            const colPlaceholders = columnNames.map((_, i) => `$${base + i + 1}`);
            placeholders.push(
                `(${colPlaceholders.join(", ")}, ST_GeomFromText($${base + columnNames.length + 1}, 4326)::geography)`
            );

            for (const col of columnNames) {
                // Handle case-insensitive property lookup
                const propKey = Object.keys(props).find(
                    (k) => k.toLowerCase() === col.toLowerCase()
                );
                // Sanitize string values to remove null bytes
                const rawValue = propKey ? props[propKey] : null;
                values.push(sanitizeString(rawValue));
            }
            values.push(wkt);
        }

        if (placeholders.length > 0) {
            const sql = `
                INSERT INTO ${tableName} (${columnNames.join(", ")}, geom)
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
            process.stdout.write(`\r  Imported ${total} features...`);
        }

        result = await source.read();
    }

    // Flush remaining
    await flushBatch();
    console.log(`\r  ✓ Imported ${total} features into ${tableName}`);

    // Create spatial index
    await pool.query(`CREATE INDEX idx_${tableName}_geom ON ${tableName} USING GIST(geom)`);
    await pool.query(`ANALYZE ${tableName}`);
    console.log(`  ✓ Created spatial index`);
};

/**
 * Import admin boundaries. Control which datasets to import via env vars:
 *   IMPORT_COUNTRIES=true  - Import countries (default: true if no env vars set)
 *   IMPORT_STATES=true     - Import states/provinces
 *   IMPORT_COUNTIES=true   - Import US counties
 * 
 * Or set IMPORT_ONLY to run just one:
 *   IMPORT_ONLY=countries
 *   IMPORT_ONLY=states
 *   IMPORT_ONLY=usCounties
 */
const importAdminBoundaries = async () => {
    console.log("=== Importing Administrative Boundaries ===\n");

    ensureDataDir();

    // Determine which datasets to import
    const importOnly = process.env.IMPORT_ONLY;
    let datasetsToImport: string[];

    if (importOnly) {
        datasetsToImport = [importOnly];
        console.log(`IMPORT_ONLY=${importOnly} - importing single dataset\n`);
    } else {
        // Check individual flags, default to all if none set
        const hasAnyFlag = process.env.IMPORT_COUNTRIES || process.env.IMPORT_STATES || process.env.IMPORT_COUNTIES;
        
        datasetsToImport = [];
        if (!hasAnyFlag || process.env.IMPORT_COUNTRIES === "true") datasetsToImport.push("countries");
        if (!hasAnyFlag || process.env.IMPORT_STATES === "true") datasetsToImport.push("states");
        if (!hasAnyFlag || process.env.IMPORT_COUNTIES === "true") datasetsToImport.push("usCounties");
    }

    console.log(`Datasets to import: ${datasetsToImport.join(", ")}\n`);

    // Download and import each dataset
    for (const name of datasetsToImport) {
        const config = DOWNLOADS[name as keyof typeof DOWNLOADS];
        if (!config) {
            console.error(`Unknown dataset: ${name}`);
            continue;
        }

        console.log(`\n[${name}]`);

        try {
            // Download
            const zipPath = await downloadFile(config.url, config.file);

            // Extract
            const extractDir = path.join(DATA_DIR, config.file);
            if (!fs.existsSync(extractDir)) {
                await extractZip(zipPath, extractDir);
            } else {
                console.log(`  ${config.file} already extracted, skipping`);
            }

            // Find the .shp file (also check subdirectories)
            let shpPath: string | null = null;
            const findShpFile = (dir: string): string | null => {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        const found = findShpFile(fullPath);
                        if (found) return found;
                    } else if (file.endsWith(".shp")) {
                        return fullPath;
                    }
                }
                return null;
            };

            shpPath = findShpFile(extractDir);

            if (!shpPath) {
                console.error(`  ERROR: No .shp file found in ${extractDir}`);
                console.log(`  Contents: ${fs.readdirSync(extractDir).join(", ")}`);
                continue;
            }

            console.log(`  Found shapefile: ${path.basename(shpPath)}`);

            // Import to PostGIS using Node.js shapefile parser
            await importShapefile(shpPath, config.table, config.columns);
        } catch (error) {
            console.error(`  ERROR processing ${name}:`, error);
        }
    }

    console.log("\n=== Import Complete ===");
    console.log("\nNext step: Run enrichGeocodingPostGIS() to geocode peaks");
};

export default importAdminBoundaries;
