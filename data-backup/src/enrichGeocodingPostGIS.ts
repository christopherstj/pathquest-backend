import getCloudSqlConnection from "./getCloudSqlConnection";

/**
 * Geocodes peaks using PostGIS spatial joins against imported admin boundary tables.
 * Much faster than API-based geocoding - processes all 600k+ peaks in minutes.
 * 
 * Prerequisites:
 * - Run importAdminBoundaries() first to populate:
 *   - admin_countries (Natural Earth countries)
 *   - admin_states (Natural Earth states/provinces)
 *   - admin_us_counties (US Census counties)
 * - Ensure geometry columns exist (run once if missing):
 *   - peaks.location_geom (GEOMETRY) populated from location_coords::geometry
 *   - admin_*.geom_geom (GEOMETRY) populated from geom::geometry
 *   - GiST indexes on all geometry columns
 *
 * Batching:
 * - This script runs in batches so progress is observable and work commits incrementally.
 * - Configure with env vars:
 *   - GEOCODING_POSTGIS_BATCH_SIZE (default: 50000)
 *   - GEOCODING_POSTGIS_MAX_BATCHES (default: unlimited)
 *   - GEOCODING_POSTGIS_PRINT_EVERY (default: 1) (print every N batches)
 */
const enrichGeocodingPostGIS = async () => {
    const pool = await getCloudSqlConnection();
    
    console.log("=== Geocoding Peaks via PostGIS Spatial Joins ===\n");
    
    // Check if admin tables exist
    const tablesCheck = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_name IN ('admin_countries', 'admin_states', 'admin_us_counties')
    `);
    
    const existingTables = tablesCheck.rows.map((r) => r.table_name);
    console.log(`Found admin tables: ${existingTables.join(", ") || "none"}`);
    
    if (existingTables.length === 0) {
        console.error("\nERROR: No admin boundary tables found.");
        console.error("Please run importAdminBoundaries() first.");
        return;
    }
    
    // Get initial counts
    const beforeCount = await pool.query(`
        SELECT 
            COUNT(*) FILTER (WHERE country IS NULL) as missing_country,
            COUNT(*) FILTER (WHERE state IS NULL) as missing_state,
            COUNT(*) FILTER (WHERE county IS NULL) as missing_county
        FROM peaks
    `);
    
    console.log("\nBefore geocoding:");
    console.log(`  Missing country: ${parseInt(beforeCount.rows[0].missing_country).toLocaleString()}`);
    console.log(`  Missing state: ${parseInt(beforeCount.rows[0].missing_state).toLocaleString()}`);
    console.log(`  Missing county: ${parseInt(beforeCount.rows[0].missing_county).toLocaleString()}`);

    const batchSize = Math.max(
        1,
        parseInt(process.env.GEOCODING_POSTGIS_BATCH_SIZE ?? "50000", 10)
    );
    const maxBatchesRaw = process.env.GEOCODING_POSTGIS_MAX_BATCHES;
    const maxBatches = maxBatchesRaw ? Math.max(1, parseInt(maxBatchesRaw, 10)) : null;
    const printEvery = Math.max(
        1,
        parseInt(process.env.GEOCODING_POSTGIS_PRINT_EVERY ?? "1", 10)
    );

    console.log("\nBatch settings:");
    console.log(`  Batch size: ${batchSize.toLocaleString()}`);
    console.log(`  Max batches: ${maxBatches ? maxBatches.toLocaleString() : "unlimited"}`);
    console.log(`  Print every: ${printEvery} batch(es)`);

    const runBatchedUpdate = async (opts: {
        label: string;
        updateSql: string;
        remainingCountSql: string;
    }) => {
        console.log(`\n${opts.label}`);
        let totalUpdated = 0;
        let batchNum = 0;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            batchNum += 1;
            const started = Date.now();

            const res = await pool.query(opts.updateSql, [batchSize]);
            const updated = res.rowCount ?? 0;
            totalUpdated += updated;

            const elapsedMs = Date.now() - started;
            const shouldPrint = batchNum % printEvery === 0 || updated === 0;

            if (shouldPrint) {
                const remainingRes = await pool.query(opts.remainingCountSql);
                const remaining = parseInt(remainingRes.rows[0].count, 10);
                console.log(
                    `  Batch ${batchNum}${maxBatches ? `/${maxBatches}` : ""}: ` +
                        `${updated.toLocaleString()} updated in ${(elapsedMs / 1000).toFixed(1)}s ` +
                        `| Remaining: ${remaining.toLocaleString()}`
                );
            }

            if (updated === 0) break;
            if (maxBatches && batchNum >= maxBatches) break;
        }

        console.log(`  ✓ Total updated: ${totalUpdated.toLocaleString()}`);
    };
    
    // Step 1: Update countries
    // Use pre-computed geometry columns (location_geom, geom_geom) for fast indexed spatial joins
    if (existingTables.includes("admin_countries")) {
        await runBatchedUpdate({
            label: "[1/3] Updating countries (batched)...",
            updateSql: `
                WITH matched AS (
                    SELECT p.id, c.iso_a2
                    FROM peaks p
                    JOIN admin_countries c
                      ON ST_Contains(c.geom_geom, p.location_geom)
                    WHERE p.country IS NULL
                    LIMIT $1
                )
                UPDATE peaks p
                SET country = matched.iso_a2,
                    geocoding_enriched_at = NOW()
                FROM matched
                WHERE p.id = matched.id
            `,
            remainingCountSql: `
                SELECT COUNT(*)::text as count
                FROM peaks
                WHERE country IS NULL
            `,
        });
    } else {
        console.log("\n[1/3] Skipping countries (table not found)");
    }
    
    // Step 2: Update states/provinces
    if (existingTables.includes("admin_states")) {
        await runBatchedUpdate({
            label: "[2/3] Updating states/provinces (batched)...",
            updateSql: `
                WITH matched AS (
                    SELECT
                        p.id,
                        CASE
                            WHEN s.iso_3166_2 LIKE '%-%' THEN SPLIT_PART(s.iso_3166_2, '-', 2)
                            ELSE COALESCE(s.postal, s.iso_3166_2, s.name)
                        END as state_value
                    FROM peaks p
                    JOIN admin_states s
                      ON ST_Contains(s.geom_geom, p.location_geom)
                    WHERE p.state IS NULL
                    LIMIT $1
                )
                UPDATE peaks p
                SET state = matched.state_value,
                    geocoding_enriched_at = NOW()
                FROM matched
                WHERE p.id = matched.id
            `,
            remainingCountSql: `
                SELECT COUNT(*)::text as count
                FROM peaks
                WHERE state IS NULL
            `,
        });
    } else {
        console.log("\n[2/3] Skipping states (table not found)");
    }
    
    // Step 3: Update US counties
    if (existingTables.includes("admin_us_counties")) {
        await runBatchedUpdate({
            label: "[3/3] Updating US counties (batched)...",
            updateSql: `
                WITH matched AS (
                    SELECT
                        p.id,
                        COALESCE(c.namelsad, c.name) as county_value
                    FROM peaks p
                    JOIN admin_us_counties c
                      ON ST_Contains(c.geom_geom, p.location_geom)
                    WHERE p.county IS NULL
                      AND p.country IN ('US', 'United States', 'USA')
                    LIMIT $1
                )
                UPDATE peaks p
                SET county = matched.county_value,
                    geocoding_enriched_at = NOW()
                FROM matched
                WHERE p.id = matched.id
            `,
            remainingCountSql: `
                SELECT COUNT(*)::text as count
                FROM peaks
                WHERE county IS NULL
                  AND country IN ('US', 'United States', 'USA')
            `,
        });
    } else {
        console.log("\n[3/3] Skipping US counties (table not found)");
    }
    
    // Get final counts
    const afterCount = await pool.query(`
        SELECT 
            COUNT(*) FILTER (WHERE country IS NULL) as missing_country,
            COUNT(*) FILTER (WHERE state IS NULL) as missing_state,
            COUNT(*) FILTER (WHERE county IS NULL) as missing_county,
            COUNT(*) as total
        FROM peaks
    `);
    
    console.log("\n=== Geocoding Complete ===\n");
    console.log("After geocoding:");
    console.log(`  Missing country: ${parseInt(afterCount.rows[0].missing_country).toLocaleString()}`);
    console.log(`  Missing state: ${parseInt(afterCount.rows[0].missing_state).toLocaleString()}`);
    console.log(`  Missing county: ${parseInt(afterCount.rows[0].missing_county).toLocaleString()}`);
    console.log(`  Total peaks: ${parseInt(afterCount.rows[0].total).toLocaleString()}`);
    
    // Summary
    const countriesFilled = parseInt(beforeCount.rows[0].missing_country) - parseInt(afterCount.rows[0].missing_country);
    const statesFilled = parseInt(beforeCount.rows[0].missing_state) - parseInt(afterCount.rows[0].missing_state);
    const countiesFilled = parseInt(beforeCount.rows[0].missing_county) - parseInt(afterCount.rows[0].missing_county);
    
    console.log("\nSummary:");
    console.log(`  Countries filled: ${countriesFilled.toLocaleString()}`);
    console.log(`  States filled: ${statesFilled.toLocaleString()}`);
    console.log(`  Counties filled: ${countiesFilled.toLocaleString()}`);
};

export default enrichGeocodingPostGIS;

