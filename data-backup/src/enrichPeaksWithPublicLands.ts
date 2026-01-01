import getCloudSqlConnection from "./getCloudSqlConnection";

/**
 * Populates peaks_public_lands junction table using PostGIS spatial joins.
 * 
 * Prerequisites:
 * - public_lands table populated (via importPublicLands or ogr2ogr)
 * - peaks.location_geom column populated
 * - GiST indexes on public_lands.geom and peaks.location_geom
 * 
 * This creates a many-to-many relationship since peaks can be in
 * multiple overlapping public lands (e.g., Wilderness inside National Forest).
 */

const BATCH_SIZE = parseInt(process.env.PUBLIC_LANDS_BATCH_SIZE || "10000", 10);
const MAX_BATCHES = parseInt(process.env.PUBLIC_LANDS_MAX_BATCHES || "0", 10) || Infinity;

const enrichPeaksWithPublicLands = async () => {
    const pool = await getCloudSqlConnection();
    
    console.log("=== Populating peaks_public_lands Junction Table ===\n");
    
    // Check if tables exist
    const tableCheck = await pool.query(`
        SELECT 
            (SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'public_lands')) as has_lands,
            (SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'peaks_public_lands')) as has_junction
    `);
    
    if (!tableCheck.rows[0].has_lands) {
        console.error("ERROR: public_lands table not found.");
        return;
    }
    if (!tableCheck.rows[0].has_junction) {
        console.error("ERROR: peaks_public_lands junction table not found.");
        console.log("Create it with:");
        console.log(`  CREATE TABLE peaks_public_lands (
    peak_id VARCHAR NOT NULL,
    public_land_id INT NOT NULL,
    PRIMARY KEY (peak_id, public_land_id)
  );`);
        return;
    }
    
    // Get counts
    const counts = await pool.query(`
        SELECT 
            (SELECT COUNT(*) FROM peaks WHERE country IN ('US', 'United States', 'USA')) as us_peaks,
            (SELECT COUNT(*) FROM public_lands) as public_lands,
            (SELECT COUNT(*) FROM peaks_public_lands) as existing_links
    `);
    
    console.log(`US peaks: ${parseInt(counts.rows[0].us_peaks).toLocaleString()}`);
    console.log(`Public lands: ${parseInt(counts.rows[0].public_lands).toLocaleString()}`);
    console.log(`Existing links: ${parseInt(counts.rows[0].existing_links).toLocaleString()}`);
    
    // Check how many US peaks haven't been checked yet (and not already in junction)
    const uncheckedCount = await pool.query(`
        SELECT COUNT(*) as count
        FROM peaks p
        WHERE p.country IN ('US', 'United States', 'USA')
          AND (p.public_lands_checked IS NULL OR p.public_lands_checked = FALSE)
          AND NOT EXISTS (SELECT 1 FROM peaks_public_lands ppl WHERE ppl.peak_id = p.id)
    `);
    const toProcess = parseInt(uncheckedCount.rows[0].count);
    
    console.log(`\nUS peaks not yet processed: ${toProcess.toLocaleString()}`);
    
    if (toProcess === 0) {
        console.log("✓ All US peaks already checked!");
        return;
    }
    
    console.log(`\nBatch size: ${BATCH_SIZE.toLocaleString()}, Max batches: ${MAX_BATCHES === Infinity ? "unlimited" : MAX_BATCHES}`);
    console.log("Finding peaks within public land boundaries...\n");
    
    // Add tracking column if not exists
    await pool.query(`
        ALTER TABLE peaks ADD COLUMN IF NOT EXISTS public_lands_checked BOOLEAN DEFAULT FALSE
    `);
    
    // Process in batches
    let batchNum = 0;
    let totalInserted = 0;
    let totalPeaksProcessed = 0;
    
    while (batchNum < MAX_BATCHES) {
        batchNum++;
        const startTime = Date.now();
        
        // Get batch of unprocessed US peaks (not checked AND not already in junction table)
        const peakBatch = await pool.query(`
            SELECT p.id, p.location_geom
            FROM peaks p
            WHERE p.country IN ('US', 'United States', 'USA')
              AND (p.public_lands_checked IS NULL OR p.public_lands_checked = FALSE)
              AND NOT EXISTS (SELECT 1 FROM peaks_public_lands ppl WHERE ppl.peak_id = p.id)
            LIMIT $1
        `, [BATCH_SIZE]);
        
        if (peakBatch.rows.length === 0) {
            console.log("\n✓ All US peaks processed!");
            break;
        }
        
        const peakIds = peakBatch.rows.map(r => r.id);
        
        // Find all public land matches for these peaks
        const matches = await pool.query(`
            INSERT INTO peaks_public_lands (peak_id, public_land_id)
            SELECT p.id, pl.objectid
            FROM peaks p
            JOIN public_lands pl ON ST_Contains(pl.geom, p.location_geom)
            WHERE p.id = ANY($1)
            ON CONFLICT DO NOTHING
            RETURNING peak_id
        `, [peakIds]);
        
        // Mark all peaks in batch as checked (whether they matched or not)
        await pool.query(`
            UPDATE peaks SET public_lands_checked = TRUE WHERE id = ANY($1)
        `, [peakIds]);
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const inserted = matches.rowCount || 0;
        const peaksWithMatches = new Set(matches.rows.map(r => r.peak_id)).size;
        totalInserted += inserted;
        totalPeaksProcessed += peakBatch.rows.length;
        
        // Check remaining
        const remaining = await pool.query(`
            SELECT COUNT(*) as count FROM peaks p
            WHERE p.country IN ('US', 'United States', 'USA') 
              AND (p.public_lands_checked IS NULL OR p.public_lands_checked = FALSE)
              AND NOT EXISTS (SELECT 1 FROM peaks_public_lands ppl WHERE ppl.peak_id = p.id)
        `);
        const left = parseInt(remaining.rows[0].count);
        
        console.log(`Batch ${batchNum}: checked ${peakBatch.rows.length.toLocaleString()} peaks, ${peaksWithMatches.toLocaleString()} in public lands (${inserted.toLocaleString()} links) in ${elapsed}s | ${left.toLocaleString()} remaining`);
    }
    
    // Final summary
    const finalCounts = await pool.query(`
        SELECT 
            COUNT(DISTINCT peak_id) as peaks_with_lands,
            COUNT(*) as total_links
        FROM peaks_public_lands
    `);
    
    console.log(`\n=== Summary ===`);
    console.log(`Total links created: ${totalInserted.toLocaleString()}`);
    console.log(`Peaks with public land: ${parseInt(finalCounts.rows[0].peaks_with_lands).toLocaleString()}`);
    console.log(`Total peak↔land links: ${parseInt(finalCounts.rows[0].total_links).toLocaleString()}`);
    
    // Show some examples of peaks with multiple lands
    const multiLand = await pool.query(`
        SELECT p.name, p.state, COUNT(*) as land_count
        FROM peaks_public_lands ppl
        JOIN peaks p ON p.id = ppl.peak_id
        GROUP BY p.id, p.name, p.state
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 10
    `);
    
    if (multiLand.rows.length > 0) {
        console.log("\nPeaks in multiple public lands:");
        for (const row of multiLand.rows) {
            console.log(`  ${row.name} (${row.state}): ${row.land_count} overlapping areas`);
        }
    }
};

export default enrichPeaksWithPublicLands;
