import getCloudSqlConnection from "./getCloudSqlConnection";

/**
 * Fixes invalid geometries in public_lands table with progress logging.
 * Processes one at a time so we can see which lands are being fixed.
 */

const BATCH_SIZE = parseInt(process.env.FIX_GEOM_BATCH_SIZE || "50", 10);
const MAX_BATCHES = parseInt(process.env.FIX_GEOM_MAX_BATCHES || "0", 10) || Infinity;
const MAX_VERTICES = parseInt(process.env.FIX_GEOM_MAX_VERTICES || "100000", 10);

const fixInvalidGeometries = async () => {
    const pool = await getCloudSqlConnection();
    
    console.log("=== Fixing Invalid Geometries in public_lands ===\n");
    
    // Get count of invalid geometries
    const countResult = await pool.query(`
        SELECT COUNT(*) as count FROM public_lands WHERE NOT ST_IsValid(geom)
    `);
    const totalInvalid = parseInt(countResult.rows[0].count);
    
    // Count fixable (under vertex limit) vs skipped
    const fixableResult = await pool.query(`
        SELECT COUNT(*) as count FROM public_lands 
        WHERE NOT ST_IsValid(geom) AND ST_NPoints(geom) <= $1
    `, [MAX_VERTICES]);
    const fixable = parseInt(fixableResult.rows[0].count);
    const skipped = totalInvalid - fixable;
    
    if (totalInvalid === 0) {
        console.log("✓ No invalid geometries found!");
        return;
    }
    
    console.log(`Found ${totalInvalid.toLocaleString()} invalid geometries`);
    console.log(`  - ${fixable.toLocaleString()} fixable (<${MAX_VERTICES.toLocaleString()} vertices)`);
    console.log(`  - ${skipped.toLocaleString()} skipped (too large - remote areas)`);
    console.log(`Batch size: ${BATCH_SIZE}, Max batches: ${MAX_BATCHES === Infinity ? "unlimited" : MAX_BATCHES}\n`);
    
    // Get list of invalid geometries with names so we can see what we're fixing
    const invalidList = await pool.query(`
        SELECT objectid, unit_nm, des_tp, state_nm, gis_acres,
               ST_NPoints(geom) as vertex_count
        FROM public_lands 
        WHERE NOT ST_IsValid(geom)
        ORDER BY gis_acres DESC NULLS LAST
        LIMIT 20
    `);
    
    console.log("Top 20 invalid geometries (by size):");
    for (const row of invalidList.rows) {
        const name = row.unit_nm || "(unnamed)";
        const type = row.des_tp || "?";
        const state = row.state_nm || "?";
        const acres = row.gis_acres ? parseInt(row.gis_acres).toLocaleString() : "?";
        const vertices = row.vertex_count ? parseInt(row.vertex_count).toLocaleString() : "?";
        console.log(`  - ${name} (${type}) - ${state} - ${acres} acres - ${vertices} vertices`);
    }
    console.log("");
    
    // Process in batches
    let totalFixed = 0;
    let batchNum = 0;
    
    while (batchNum < MAX_BATCHES) {
        batchNum++;
        const startTime = Date.now();
        
        // Get a batch of invalid geometries (smallest first, skip huge ones)
        const batch = await pool.query(`
            SELECT objectid, unit_nm, des_tp, ST_NPoints(geom) as vertices
            FROM public_lands 
            WHERE NOT ST_IsValid(geom) AND ST_NPoints(geom) <= $2
            ORDER BY ST_NPoints(geom) ASC
            LIMIT $1
        `, [BATCH_SIZE, MAX_VERTICES]);
        
        if (batch.rows.length === 0) {
            console.log("\n✓ All geometries fixed!");
            break;
        }
        
        // Log what we're fixing
        const names = batch.rows.map(r => `${r.unit_nm || "unnamed"} (${r.vertices} verts)`).join(", ");
        console.log(`Batch ${batchNum}: Fixing ${batch.rows.length} geometries...`);
        console.log(`  ${names.substring(0, 200)}${names.length > 200 ? "..." : ""}`);
        
        // Fix the batch
        const ids = batch.rows.map(r => r.objectid);
        try {
            await pool.query(`
                UPDATE public_lands 
                SET geom = ST_Buffer(geom, 0)
                WHERE objectid = ANY($1)
            `, [ids]);
            
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            totalFixed += batch.rows.length;
            
            // Check remaining (fixable only)
            const remaining = await pool.query(`
                SELECT COUNT(*) as count FROM public_lands 
                WHERE NOT ST_IsValid(geom) AND ST_NPoints(geom) <= $1
            `, [MAX_VERTICES]);
            const left = parseInt(remaining.rows[0].count);
            
            console.log(`  ✓ Fixed in ${elapsed}s (${totalFixed} total, ${left} remaining)\n`);
        } catch (error: any) {
            console.error(`  ✗ Error fixing batch: ${error.message}`);
            
            // Try one at a time to find the problematic one
            console.log("  Retrying one at a time...");
            for (const row of batch.rows) {
                try {
                    await pool.query(`
                        UPDATE public_lands 
                        SET geom = ST_Buffer(geom, 0)
                        WHERE objectid = $1
                    `, [row.objectid]);
                    totalFixed++;
                    console.log(`    ✓ Fixed: ${row.unit_nm || row.objectid}`);
                } catch (e: any) {
                    console.log(`    ✗ Skipped (unfixable): ${row.unit_nm || row.objectid} - ${e.message.substring(0, 50)}`);
                }
            }
            console.log("");
        }
    }
    
    console.log(`\n=== Complete ===`);
    console.log(`Fixed ${totalFixed} geometries`);
    
    // Final check
    const finalCount = await pool.query(`SELECT COUNT(*) as count FROM public_lands WHERE NOT ST_IsValid(geom)`);
    const remaining = parseInt(finalCount.rows[0].count);
    if (remaining > 0) {
        console.log(`${remaining} geometries could not be fixed (will be skipped in enrichment)`);
    }
};

export default fixInvalidGeometries;

