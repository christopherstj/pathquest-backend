import { Connection } from "mysql2/promise";
import StravaActivity from "../typeDefs/StravaActivity";

const saveActivity = async (
    connection: Connection,
    activity: StravaActivity,
    coordinates: [number, number][],
    altitude?: number[]
) => {
    const id = activity.id;
    const userId = activity.athlete.id;
    const startLat = activity.start_latlng[0];
    const startLong = activity.start_latlng[1];
    const distance = activity.distance;
    const startTime = new Date(activity.start_date).toISOString();

    await connection.execute(
        "INSERT IGNORE INTO Activity (id, userId, startLat, startLong, distance, coords, vertProfile, startTime, sport, `name`, timezone, gain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            id,
            userId,
            startLat ?? null,
            startLong ?? null,
            distance ?? null,
            coordinates ? JSON.stringify(coordinates) : null,
            altitude ? JSON.stringify(altitude) : null,
            startTime.slice(0, 19).replace("T", " "),
            activity.type,
            activity.name,
            activity.timezone ?? null,
            activity.total_elevation_gain ?? null,
        ]
    );
};

export default saveActivity;
