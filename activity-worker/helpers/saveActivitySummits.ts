import getCloudSqlConnection from "./getCloudSqlConnection";

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

    // Calculate timezone offset string (e.g., "-08:00" or "+05:30")
    const utcOffsetHours = Math.floor(Math.abs(utcOffsetSeconds) / 3600);
    const utcOffsetMinutes = Math.floor((Math.abs(utcOffsetSeconds) % 3600) / 60);
    const offsetSign = utcOffsetSeconds >= 0 ? "+" : "-";
    const timezoneOffset = `${offsetSign}${utcOffsetHours.toString().padStart(2, "0")}:${utcOffsetMinutes.toString().padStart(2, "0")}`;

    const placeholders: string[] = [];
    const values: any[] = [];

    summits.forEach((x, i) => {
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
        ON CONFLICT (id) DO NOTHING
    `;

    await pool.query(sql, values);
};

export default saveActivitySummits;
