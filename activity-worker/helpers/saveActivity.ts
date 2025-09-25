import { Connection, Pool } from "mysql2/promise";
import StravaActivity from "../typeDefs/StravaActivity";

const saveActivity = async (
    pool: Pool,
    activity: StravaActivity,
    coordinates: [number, number][],
    times: number[],
    altitude?: number[],
    distanceStream?: number[]
) => {
    const id = activity.id;
    const userId = activity.athlete.id;
    const startLat = activity.start_latlng[0];
    const startLong = activity.start_latlng[1];
    const distance = activity.distance;
    const startTime = new Date(activity.start_date).toISOString();
    const isPublic = activity.private === false || activity.private === "false";

    await pool.execute(
        `INSERT INTO Activity 
        (id, userId, startLat, startLong, distance, coords, vertProfile, distanceStream, timeStream, startTime, sport, \`name\`, timezone, gain, isPublic, activityJson) 
        VALUES 
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        startLat = ?,
        startLong = ?,
        distance = ?,
        coords = ?,
        vertProfile = ?,
        distanceStream = ?,
        timeStream = ?,
        startTime = ?,
        sport = ?,
        \`name\` = ?,
        timezone = ?,
        gain = ?,
        isPublic = ?,
        activityJson = ?,
        pendingReprocess = 0;
        `,
        [
            id,
            userId,
            startLat ?? null,
            startLong ?? null,
            distance ?? null,
            coordinates ? JSON.stringify(coordinates) : null,
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
            startLat ?? null,
            startLong ?? null,
            distance ?? null,
            coordinates ? JSON.stringify(coordinates) : null,
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
