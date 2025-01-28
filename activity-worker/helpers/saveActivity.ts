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

    const connection1 = await pool.getConnection();
    await connection1.execute(
        `INSERT INTO Activity 
        (id, userId, startLat, startLong, distance, startTime, sport, \`name\`, timezone, gain) 
        VALUES 
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        startLat = ?,
        startLong = ?,
        distance = ?,
        startTime = ?,
        sport = ?,
        \`name\` = ?,
        timezone = ?,
        gain = ?,
        pendingReprocess = 0;
        `,
        [
            id,
            userId,
            startLat ?? null,
            startLong ?? null,
            distance ?? null,
            // coordinates ? JSON.stringify(coordinates) : null,
            // altitude ? JSON.stringify(altitude) : null,
            // distanceStream ? JSON.stringify(distanceStream) : null,
            // times ? JSON.stringify(times) : null,
            startTime.slice(0, 19).replace("T", " "),
            activity.type,
            activity.name,
            activity.timezone ?? null,
            activity.total_elevation_gain ?? null,
            startLat ?? null,
            startLong ?? null,
            distance ?? null,
            // coordinates ? JSON.stringify(coordinates) : null,
            // altitude ? JSON.stringify(altitude) : null,
            // distanceStream ? JSON.stringify(distanceStream) : null,
            // times ? JSON.stringify(times) : null,
            startTime.slice(0, 19).replace("T", " "),
            activity.type,
            activity.name,
            activity.timezone ?? null,
            activity.total_elevation_gain ?? null,
        ]
    );

    connection1.release();

    if (coordinates) {
        console.log("saving coords");
        const connection = await pool.getConnection();
        await connection.execute(
            `UPDATE Activity SET coords = ? WHERE id = ?`,
            [JSON.stringify(coordinates), id]
        );
        connection.release();
    }
    if (altitude) {
        console.log("saving altitude");
        const connection = await pool.getConnection();
        await connection.execute(
            `UPDATE Activity SET vertProfile = ? WHERE id = ?`,
            [JSON.stringify(altitude), id]
        );
        connection.release();
    }
    if (distanceStream) {
        console.log("saving distance");
        const connection = await pool.getConnection();
        await connection.execute(
            `UPDATE Activity SET distanceStream = ? WHERE id = ?`,
            [JSON.stringify(distanceStream), id]
        );
        connection.release();
    }
    if (times) {
        console.log("saving times");
        const connection = await pool.getConnection();
        await connection.execute(
            `UPDATE Activity SET timeStream = ? WHERE id = ?`,
            [JSON.stringify(times), id]
        );
        connection.release();
    }
};

export default saveActivity;
