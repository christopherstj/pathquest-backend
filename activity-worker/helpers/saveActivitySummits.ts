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
    }[],
    activityId: string,
    isPublic: boolean
) => {
    const pool = await getCloudSqlConnection();

    if (!summits || summits.length === 0) return;

    const placeholders: string[] = [];
    const values: any[] = [];

    summits.forEach((x, i) => {
        const base = i * 12;
        placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${
                base + 5
            }, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${
                base + 10
            }, $${base + 11}, $${base + 12})`
        );
        values.push(
            `${activityId}-${x.peakId}-${x.timestamp.toISOString()}`,
            activityId,
            x?.peakId,
            x.timestamp.toISOString().slice(0, 19).replace("T", " "),
            isPublic ? 1 : 0,
            x.weather.temperature,
            x.weather.precipitation,
            x.weather.weatherCode,
            x.weather.cloudCover,
            x.weather.windSpeed,
            x.weather.windDirection,
            x.weather.humidity
        );
    });

    const sql = `
        INSERT INTO activities_peaks (id, activity_id, peak_id, timestamp, is_public, temperature, precipitation, weather_code, cloud_cover, wind_speed, wind_direction, humidity)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (id) DO NOTHING
    `;

    await pool.query(sql, values);
};

export default saveActivitySummits;
