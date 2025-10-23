import StravaActivity from "../typeDefs/StravaActivity";
import getCloudSqlConnection from "./getCloudSqlConnection";

const saveActivity = async (
    activity: StravaActivity,
    coordinates: [number, number][],
    times: number[],
    altitude?: number[],
    distanceStream?: number[]
) => {
    const pool = await getCloudSqlConnection();

    const id = activity.id;
    const userId = activity.athlete.id;
    const startLat = activity.start_latlng[0];
    const startLong = activity.start_latlng[1];
    const distance = activity.distance;
    const startTime = new Date(activity.start_date).toISOString();
    const isPublic = activity.private === false || activity.private === "false";

    await pool.query(
        `INSERT INTO activities
        (id, user_id, start_coords, distance, coords, vert_profile, distance_stream, time_stream, start_time, sport, title, timezone, gain, is_public, activity_json) 
        VALUES 
        ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, ST_GeomFromText($6, 4326)::geography, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO UPDATE SET
        start_coords = EXCLUDED.start_coords,
        distance = EXCLUDED.distance,
        coords = EXCLUDED.coords,
        vert_profile = EXCLUDED.vert_profile,
        distance_stream = EXCLUDED.distance_stream,
        time_stream = EXCLUDED.time_stream,
        start_time = EXCLUDED.start_time, 
        sport = EXCLUDED.sport,
        title = EXCLUDED.title,
        timezone = EXCLUDED.timezone,
        gain = EXCLUDED.gain,
        is_public = EXCLUDED.is_public,
        activity_json = EXCLUDED.activity_json;
        `,
        [
            id,
            userId,
            startLong ?? null,
            startLat ?? null,
            distance ?? null,
            coordinates
                ? `LINESTRING(${coordinates
                      .map((c) => `${c[0]} ${c[1]}`)
                      .join(", ")})`
                : null,
            altitude ? JSON.stringify(altitude) : null,
            distanceStream ? JSON.stringify(distanceStream) : null,
            times ? JSON.stringify(times) : null,
            startTime.slice(0, 19).replace("T", " "),
            activity.type,
            activity.name,
            activity.timezone ?? null,
            activity.total_elevation_gain ?? null,
            isPublic,
            JSON.stringify(activity),
        ]
    );
};

export default saveActivity;
