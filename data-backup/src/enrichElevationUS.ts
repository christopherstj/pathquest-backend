import getCloudSqlConnection from "./getCloudSqlConnection";

interface USGSElevationResponse {
    value: number;
    status: string;
}

interface PeakRow {
    id: string;
    name: string;
    lat: number;
    lon: number;
}

const USGS_EPQS_URL = "https://epqs.nationalmap.gov/v1/json";
const DELAY_MS = 100; // ~10 req/sec to be nice to USGS servers
const BATCH_SIZE = 1000; // How many peaks to fetch at once from DB

// All US state codes for identification
const US_STATE_CODES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC", "PR", "VI", "GU", "AS", "MP" // Territories
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getUSGSElevation = async (
    lat: number,
    lon: number
): Promise<number | null> => {
    try {
        const url = `${USGS_EPQS_URL}?x=${lon}&y=${lat}&wkid=4326&units=Meters`;
        const response = await fetch(url);

        if (!response.ok) {
            console.error(`USGS API error: ${response.status}`);
            return null;
        }

        const data: USGSElevationResponse = await response.json();

        // -1000000 means no data (ocean, outside US coverage, etc.)
        if (data.status !== "success" || data.value === -1000000) {
            return null;
        }

        return data.value;
    } catch (error) {
        console.error(`Error fetching elevation: ${error}`);
        return null;
    }
};

const enrichElevationUS = async () => {
    const pool = await getCloudSqlConnection();

    // Build the state code list for SQL
    const stateCodesStr = US_STATE_CODES.map((s) => `'${s}'`).join(", ");

    // Count total US peaks that need processing (not yet enriched with USGS)
    const countResult = await pool.query(`
        SELECT COUNT(*) as count
        FROM peaks 
        WHERE (
            country IN ('US', 'United States', 'USA')
            OR state IN (${stateCodesStr})
        )
        AND (elevation_source IS NULL OR elevation_source != 'usgs_3dep')
    `);

    const totalPeaks = parseInt(countResult.rows[0].count, 10);
    console.log(`Found ${totalPeaks} US peaks to enrich with USGS 3DEP elevation data`);

    if (totalPeaks === 0) {
        console.log("No peaks to process. Exiting.");
        return;
    }

    let processed = 0;
    let updated = 0;
    let failed = 0;
    let offset = 0;

    while (processed < totalPeaks) {
        // Fetch batch of peaks that haven't been enriched yet
        const { rows: peaks } = await pool.query<PeakRow>(`
            SELECT 
                id, 
                name, 
                ST_Y(location_coords::geometry) as lat,
                ST_X(location_coords::geometry) as lon
            FROM peaks 
            WHERE (
                country IN ('US', 'United States', 'USA')
                OR state IN (${stateCodesStr})
            )
            AND (elevation_source IS NULL OR elevation_source != 'usgs_3dep')
            ORDER BY id
            LIMIT ${BATCH_SIZE}
        `);

        if (peaks.length === 0) {
            break;
        }

        for (const peak of peaks) {
            const elevation = await getUSGSElevation(peak.lat, peak.lon);

            if (elevation !== null) {
                await pool.query(
                    `UPDATE peaks 
                     SET elevation = $1, 
                         elevation_source = 'usgs_3dep',
                         elevation_enriched_at = NOW()
                     WHERE id = $2`,
                    [elevation, peak.id]
                );
                updated++;
                
                if (updated % 100 === 0 || updated === 1) {
                    console.log(`✓ [${updated}] ${peak.name}: ${elevation.toFixed(1)}m`);
                }
            } else {
                // Mark as attempted even if failed (to avoid re-processing)
                await pool.query(
                    `UPDATE peaks 
                     SET elevation_source = 'usgs_3dep_failed',
                         elevation_enriched_at = NOW()
                     WHERE id = $1`,
                    [peak.id]
                );
                failed++;
                console.log(`✗ ${peak.name}: No USGS elevation data available`);
            }

            processed++;
            await sleep(DELAY_MS);

            if (processed % 500 === 0) {
                const pct = ((processed / totalPeaks) * 100).toFixed(1);
                console.log(`\n--- Progress: ${processed}/${totalPeaks} (${pct}%) | Updated: ${updated} | Failed: ${failed} ---\n`);
            }
        }

        offset += BATCH_SIZE;
    }

    console.log(`\n✓ Complete!`);
    console.log(`  Total processed: ${processed}`);
    console.log(`  Updated with elevation: ${updated}`);
    console.log(`  No data available: ${failed}`);
};

export default enrichElevationUS;

