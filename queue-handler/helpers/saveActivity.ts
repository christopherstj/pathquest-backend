import { Connection } from "mysql2/promise";
import StravaActivity from "../typeDefs/StravaActivity";
import getCloudSqlConnection from "./getCloudSqlConnection";

const saveActivity = async (
    connection: Connection,
    activity: StravaActivity,
    coordinates: [number, number][]
) => {
    const id = activity.id;
    const userId = activity.athlete.id;
    const startLat = activity.start_latlng[0];
    const startLong = activity.start_latlng[1];
    const distance = activity.distance;
    const startTime = new Date(activity.start_date).toISOString();

    await connection.execute(
        "INSERT IGNORE INTO Activity (id, userId, startLat, startLong, distance, coords, startTime) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            id,
            userId,
            startLat ?? null,
            startLong ?? null,
            distance ?? null,
            coordinates ? JSON.stringify(coordinates) : null,
            startTime.slice(0, 19).replace("T", " "),
        ]
    );
};

export default saveActivity;
