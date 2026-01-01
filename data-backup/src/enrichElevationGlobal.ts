import getCloudSqlConnection from "./getCloudSqlConnection";

interface OpenMeteoElevationResponse {
    elevation: number[];
}

interface PeakRow {
    id: string;
    name: string;
    lat: number;
    lon: number;
}

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/elevation";
const API_BATCH_SIZE = 100; // Max locations per Open-Meteo request
const DB_BATCH_SIZE = 1000; // How many peaks to fetch at once from DB
const DELAY_MS = 200; // Delay between API batch requests

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getOpenMeteoElevations = async (
    locations: { lat: number; lon: number }[]
): Promise<(number | null)[]> => {
    try {
        const lats = locations.map((l) => l.lat).join(",");
        const lons = locations.map((l) => l.lon).join(",");

        const url = `${OPEN_METEO_URL}?latitude=${lats}&longitude=${lons}`;
        const response = await fetch(url);

        if (!response.ok) {
            console.error(`Open-Meteo API error: ${response.status}`);
            return locations.map(() => null);
        }

        const data: OpenMeteoElevationResponse = await response.json();
        
        // Open-Meteo returns elevation array in same order as input
        return data.elevation.map((el) => {
            // Open-Meteo returns very negative values for ocean/invalid coords
            if (el < -1000) return null;
            return el;
        });
    } catch (error) {
        console.error(`Error fetching elevations: ${error}`);
        return locations.map(() => null);
    }
};

const enrichElevationGlobal = async () => {
    const pool = await getCloudSqlConnection();

    // Count non-US peaks missing elevation that haven't been enriched
    const countResult = await pool.query(`
        SELECT COUNT(*) as count
        FROM peaks 
        WHERE elevation IS NULL 
          AND country NOT IN ('US', 'United States', 'USA')
          AND country IS NOT NULL
          AND (elevation_enriched_at IS NULL)
    `);

    const totalPeaks = parseInt(countResult.rows[0].count, 10);
    console.log(`Found ${totalPeaks} global peaks missing elevation data`);

    if (totalPeaks === 0) {
        console.log("No peaks to process. Exiting.");
        return;
    }

    let processed = 0;
    let updated = 0;
    let failed = 0;

    while (processed < totalPeaks) {
        // Fetch batch of peaks from DB
        const { rows: peaks } = await pool.query<PeakRow>(`
            SELECT 
                id, 
                name, 
                ST_Y(location_coords::geometry) as lat,
                ST_X(location_coords::geometry) as lon
            FROM peaks 
            WHERE elevation IS NULL 
              AND country NOT IN ('US', 'United States', 'USA')
              AND country IS NOT NULL
              AND (elevation_enriched_at IS NULL)
            ORDER BY id
            LIMIT ${DB_BATCH_SIZE}
        `);

        if (peaks.length === 0) {
            break;
        }

        // Process in API batch sizes
        for (let i = 0; i < peaks.length; i += API_BATCH_SIZE) {
            const batch = peaks.slice(i, i + API_BATCH_SIZE);
            const locations = batch.map((p) => ({ lat: p.lat, lon: p.lon }));

            const elevations = await getOpenMeteoElevations(locations);

            for (let j = 0; j < batch.length; j++) {
                const peak = batch[j];
                const elevation = elevations[j];

                if (elevation !== null) {
                    await pool.query(
                        `UPDATE peaks 
                         SET elevation = $1, 
                             elevation_source = 'srtm',
                             elevation_enriched_at = NOW()
                         WHERE id = $2`,
                        [elevation, peak.id]
                    );
                    updated++;
                } else {
                    // Mark as attempted even if failed
                    await pool.query(
                        `UPDATE peaks 
                         SET elevation_source = 'srtm_failed',
                             elevation_enriched_at = NOW()
                         WHERE id = $1`,
                        [peak.id]
                    );
                    failed++;
                }

                processed++;
            }

            await sleep(DELAY_MS);

            if (processed % 500 === 0) {
                const pct = ((processed / totalPeaks) * 100).toFixed(1);
                console.log(`Progress: ${processed}/${totalPeaks} (${pct}%) | Updated: ${updated} | Failed: ${failed}`);
            }
        }
    }

    console.log(`\n✓ Complete!`);
    console.log(`  Total processed: ${processed}`);
    console.log(`  Updated with elevation: ${updated}`);
    console.log(`  No data available: ${failed}`);
};

export default enrichElevationGlobal;

