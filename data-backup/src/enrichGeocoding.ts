import getCloudSqlConnection from "./getCloudSqlConnection";

interface MapboxFeature {
    id: string;
    text: string;
    place_type: string[];
    properties: {
        short_code?: string;
    };
}

interface MapboxResponse {
    features: MapboxFeature[];
}

interface PeakRow {
    id: string;
    name: string;
    lat: number;
    lon: number;
    country: string | null;
    state: string | null;
    county: string | null;
}

interface GeocodingResult {
    country?: string;
    state?: string;
    county?: string;
}

const MAPBOX_GEOCODING_URL = "https://api.mapbox.com/geocoding/v5/mapbox.places";
const DELAY_MS = 100; // ~10 req/sec (Mapbox allows 600/min)
const DB_BATCH_SIZE = 500; // How many peaks to fetch at once from DB

// Default limit per run to stay within monthly quota
// Can be overridden via GEOCODING_LIMIT env var
const DEFAULT_LIMIT = 100000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const reverseGeocode = async (
    lat: number,
    lon: number,
    accessToken: string
): Promise<GeocodingResult> => {
    try {
        const url = `${MAPBOX_GEOCODING_URL}/${lon},${lat}.json?access_token=${accessToken}&types=country,region,district`;
        const response = await fetch(url);

        if (!response.ok) {
            console.error(`Mapbox API error: ${response.status}`);
            return {};
        }

        const data: MapboxResponse = await response.json();

        const result: GeocodingResult = {};

        for (const feature of data.features) {
            if (feature.place_type.includes("country")) {
                // Use short code (e.g., "US") if available, otherwise full name
                result.country =
                    feature.properties.short_code?.toUpperCase() || feature.text;
            } else if (feature.place_type.includes("region")) {
                // Region = state/province
                // short_code format is "US-CA" for California, extract just "CA"
                const shortCode = feature.properties.short_code;
                if (shortCode && shortCode.includes("-")) {
                    result.state = shortCode.split("-")[1];
                } else {
                    result.state = shortCode || feature.text;
                }
            } else if (feature.place_type.includes("district")) {
                // District = county
                result.county = feature.text;
            }
        }

        return result;
    } catch (error) {
        console.error(`Error geocoding: ${error}`);
        return {};
    }
};

const enrichGeocoding = async () => {
    const pool = await getCloudSqlConnection();
    const accessToken = process.env.MAPBOX_API_KEY;

    if (!accessToken) {
        throw new Error("MAPBOX_API_KEY environment variable required");
    }

    const limit = parseInt(process.env.GEOCODING_LIMIT || String(DEFAULT_LIMIT), 10);
    console.log(`Geocoding limit set to: ${limit.toLocaleString()} peaks`);

    // PASS 1: Peaks with no geocoding data at all
    console.log("\n=== PASS 1: Peaks with no country/state/county ===\n");

    const countPass1 = await pool.query(`
        SELECT COUNT(*) as count
        FROM peaks 
        WHERE country IS NULL 
          AND state IS NULL 
          AND county IS NULL
          AND geocoding_enriched_at IS NULL
    `);

    const pass1Total = parseInt(countPass1.rows[0].count, 10);
    console.log(`Found ${pass1Total.toLocaleString()} peaks with no geocoding data`);

    let totalProcessed = 0;
    let totalUpdated = 0;

    // Process Pass 1
    while (totalProcessed < limit) {
        const { rows: peaks } = await pool.query<PeakRow>(`
            SELECT 
                id, 
                name, 
                ST_Y(location_coords::geometry) as lat,
                ST_X(location_coords::geometry) as lon,
                country,
                state,
                county
            FROM peaks 
            WHERE country IS NULL 
              AND state IS NULL 
              AND county IS NULL
              AND geocoding_enriched_at IS NULL
            ORDER BY id
            LIMIT ${DB_BATCH_SIZE}
        `);

        if (peaks.length === 0) {
            console.log("Pass 1 complete - no more peaks to process");
            break;
        }

        for (const peak of peaks) {
            if (totalProcessed >= limit) break;

            const result = await reverseGeocode(peak.lat, peak.lon, accessToken);

            if (result.country || result.state || result.county) {
                await pool.query(
                    `UPDATE peaks 
                     SET country = COALESCE($1, country),
                         state = COALESCE($2, state),
                         county = COALESCE($3, county),
                         geocoding_enriched_at = NOW()
                     WHERE id = $4`,
                    [result.country, result.state, result.county, peak.id]
                );
                totalUpdated++;

                if (totalUpdated % 100 === 0 || totalUpdated === 1) {
                    console.log(
                        `✓ [${totalUpdated}] ${peak.name}: ${result.country || "?"}/${result.state || "?"}/${result.county || "?"}`
                    );
                }
            } else {
                // Mark as attempted even if no data returned
                await pool.query(
                    `UPDATE peaks 
                     SET geocoding_enriched_at = NOW()
                     WHERE id = $1`,
                    [peak.id]
                );
            }

            totalProcessed++;
            await sleep(DELAY_MS);

            if (totalProcessed % 1000 === 0) {
                const pct = ((totalProcessed / limit) * 100).toFixed(1);
                console.log(
                    `\n--- Progress: ${totalProcessed.toLocaleString()}/${limit.toLocaleString()} (${pct}%) | Updated: ${totalUpdated.toLocaleString()} ---\n`
                );
            }
        }
    }

    // PASS 2: Peaks with country but missing state/county
    if (totalProcessed < limit) {
        console.log("\n=== PASS 2: Peaks with country but missing state ===\n");

        const countPass2 = await pool.query(`
            SELECT COUNT(*) as count
            FROM peaks 
            WHERE country IS NOT NULL 
              AND state IS NULL
              AND geocoding_enriched_at IS NULL
        `);

        const pass2Total = parseInt(countPass2.rows[0].count, 10);
        console.log(`Found ${pass2Total.toLocaleString()} peaks with country but missing state`);

        while (totalProcessed < limit) {
            const { rows: peaks } = await pool.query<PeakRow>(`
                SELECT 
                    id, 
                    name, 
                    ST_Y(location_coords::geometry) as lat,
                    ST_X(location_coords::geometry) as lon,
                    country,
                    state,
                    county
                FROM peaks 
                WHERE country IS NOT NULL 
                  AND state IS NULL
                  AND geocoding_enriched_at IS NULL
                ORDER BY id
                LIMIT ${DB_BATCH_SIZE}
            `);

            if (peaks.length === 0) {
                console.log("Pass 2 complete - no more peaks to process");
                break;
            }

            for (const peak of peaks) {
                if (totalProcessed >= limit) break;

                const result = await reverseGeocode(peak.lat, peak.lon, accessToken);

                if (result.state || result.county) {
                    await pool.query(
                        `UPDATE peaks 
                         SET state = COALESCE($1, state),
                             county = COALESCE($2, county),
                             geocoding_enriched_at = NOW()
                         WHERE id = $3`,
                        [result.state, result.county, peak.id]
                    );
                    totalUpdated++;

                    if (totalUpdated % 100 === 0) {
                        console.log(
                            `✓ [${totalUpdated}] ${peak.name}: ${peak.country}/${result.state || "?"}/${result.county || "?"}`
                        );
                    }
                } else {
                    await pool.query(
                        `UPDATE peaks 
                         SET geocoding_enriched_at = NOW()
                         WHERE id = $1`,
                        [peak.id]
                    );
                }

                totalProcessed++;
                await sleep(DELAY_MS);

                if (totalProcessed % 1000 === 0) {
                    const pct = ((totalProcessed / limit) * 100).toFixed(1);
                    console.log(
                        `\n--- Progress: ${totalProcessed.toLocaleString()}/${limit.toLocaleString()} (${pct}%) | Updated: ${totalUpdated.toLocaleString()} ---\n`
                    );
                }
            }
        }
    }

    console.log(`\n✓ Geocoding complete!`);
    console.log(`  Total processed: ${totalProcessed.toLocaleString()}`);
    console.log(`  Total updated: ${totalUpdated.toLocaleString()}`);
    console.log(`  Remaining quota for this run: ${(limit - totalProcessed).toLocaleString()}`);
};

export default enrichGeocoding;

