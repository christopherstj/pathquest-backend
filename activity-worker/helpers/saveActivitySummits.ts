import getCloudSqlConnection from "./getCloudSqlConnection";

// 5 minute buffer to prevent duplicate summits of the same peak
const DUPLICATE_BUFFER_MINUTES = 5;

const saveActivitySummits = async (
    summits: {
        peakId: string;
        timestamp: Date;
        activityId: number;
        weather: {
            temperature: number;
            precipitation: number;
            weatherCode: number;
            cloudCover: number;
            windSpeed: number;
            windDirection: number;
            humidity: number;
        };
        confidenceScore: number;
        needsConfirmation: boolean;
    }[],
    activityId: string,
    isPublic: boolean,
    utcOffsetSeconds: number = 0
) => {
    const pool = await getCloudSqlConnection();

    if (!summits || summits.length === 0) return;

    // Get the user_id for this activity to check for duplicates across all their activities
    const { rows: activityRows } = await pool.query(
        `SELECT user_id FROM activities WHERE id = $1`,
        [activityId]
    );
    
    if (activityRows.length === 0) {
        console.warn(`[saveActivitySummits] Activity ${activityId} not found, skipping duplicate check`);
    }
    
    const userId = activityRows[0]?.user_id;

    // Filter out summits that already exist within 5 minutes for this user
    let filteredSummits = summits;
    
    if (userId) {
        // Get existing summits for this user within the time range of the new summits
        const minTimestamp = new Date(Math.min(...summits.map(s => s.timestamp.getTime())) - DUPLICATE_BUFFER_MINUTES * 60 * 1000);
        const maxTimestamp = new Date(Math.max(...summits.map(s => s.timestamp.getTime())) + DUPLICATE_BUFFER_MINUTES * 60 * 1000);
        
        const { rows: existingSummits } = await pool.query(
            `SELECT ap.peak_id, ap.timestamp, ap.activity_id
             FROM activities_peaks ap
             JOIN activities a ON ap.activity_id = a.id
             WHERE a.user_id = $1
               AND ap.timestamp BETWEEN $2 AND $3
               AND ap.activity_id != $4`,
            [userId, minTimestamp.toISOString(), maxTimestamp.toISOString(), activityId]
        );
        
        // Also check manual summits
        const { rows: existingManualSummits } = await pool.query(
            `SELECT peak_id, timestamp
             FROM user_peak_manual
             WHERE user_id = $1
               AND timestamp BETWEEN $2 AND $3`,
            [userId, minTimestamp.toISOString(), maxTimestamp.toISOString()]
        );
        
        const allExisting = [...existingSummits, ...existingManualSummits];
        
        if (allExisting.length > 0) {
            filteredSummits = summits.filter(newSummit => {
                const isDuplicate = allExisting.some(existing => {
                    if (existing.peak_id !== newSummit.peakId) return false;
                    const timeDiffMs = Math.abs(new Date(existing.timestamp).getTime() - newSummit.timestamp.getTime());
                    return timeDiffMs <= DUPLICATE_BUFFER_MINUTES * 60 * 1000;
                });
                
                if (isDuplicate) {
                    console.log(`[saveActivitySummits] Skipping duplicate summit: peak ${newSummit.peakId} at ${newSummit.timestamp.toISOString()} (already exists within ${DUPLICATE_BUFFER_MINUTES} minutes)`);
                }
                
                return !isDuplicate;
            });
            
            if (filteredSummits.length < summits.length) {
                console.log(`[saveActivitySummits] Filtered out ${summits.length - filteredSummits.length} duplicate summit(s)`);
            }
        }
    }
    
    if (filteredSummits.length === 0) {
        console.log(`[saveActivitySummits] All summits were duplicates, nothing to save`);
        return;
    }

    // Calculate timezone offset string (e.g., "-08:00" or "+05:30")
    const utcOffsetHours = Math.floor(Math.abs(utcOffsetSeconds) / 3600);
    const utcOffsetMinutes = Math.floor((Math.abs(utcOffsetSeconds) % 3600) / 60);
    const offsetSign = utcOffsetSeconds >= 0 ? "+" : "-";
    const timezoneOffset = `${offsetSign}${utcOffsetHours.toString().padStart(2, "0")}:${utcOffsetMinutes.toString().padStart(2, "0")}`;

    const placeholders: string[] = [];
    const values: any[] = [];

    filteredSummits.forEach((x, i) => {
        const base = i * 14; // Now 14 fields per summit
        placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${
                base + 5
            }, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${
                base + 10
            }, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14})`
        );
        // Convert UTC timestamp to local time and construct ISO string with timezone offset
        // x.timestamp is a UTC Date object. To get local time representation:
        // local_time = UTC_time + offset (offset is negative for timezones behind UTC)
        const localTimeMs = x.timestamp.getTime() + utcOffsetSeconds * 1000;
        const localDate = new Date(localTimeMs);
        // Format as YYYY-MM-DD HH:MM:SS using UTC methods since we've already adjusted the time
        const year = localDate.getUTCFullYear();
        const month = String(localDate.getUTCMonth() + 1).padStart(2, "0");
        const day = String(localDate.getUTCDate()).padStart(2, "0");
        const hours = String(localDate.getUTCHours()).padStart(2, "0");
        const minutes = String(localDate.getUTCMinutes()).padStart(2, "0");
        const seconds = String(localDate.getUTCSeconds()).padStart(2, "0");
        const localTimeString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        const timestampWithTz = `${localTimeString}${timezoneOffset}`;
        
        values.push(
            `${activityId}-${x.peakId}-${x.timestamp.toISOString()}`,
            activityId,
            x?.peakId,
            timestampWithTz,
            isPublic ? 1 : 0,
            x.weather.temperature,
            x.weather.precipitation,
            x.weather.weatherCode,
            x.weather.cloudCover,
            x.weather.windSpeed,
            x.weather.windDirection,
            x.weather.humidity,
            // New fields for confidence scoring
            Math.round(x.confidenceScore * 100) / 100, // Round to 2 decimal places
            x.needsConfirmation
        );
    });

    const sql = `
        INSERT INTO activities_peaks (id, activity_id, peak_id, timestamp, is_public, temperature, precipitation, weather_code, cloud_cover, wind_speed, wind_direction, humidity, confidence_score, needs_confirmation)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (id) DO UPDATE SET
            confidence_score = EXCLUDED.confidence_score,
            needs_confirmation = EXCLUDED.needs_confirmation
    `;

    await pool.query(sql, values);
};

export default saveActivitySummits;
