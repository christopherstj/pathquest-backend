import StravaActivity from "../typeDefs/StravaActivity";
import mysql from "mysql2/promise";

const saveActivity = async (
    activity: StravaActivity,
    coordinates: [number, number][]
) => {
    const connection = await mysql.createConnection({
        host: "127.0.0.1",
        user: "local-user",
        database: "dev-db",
        password: process.env.MYSQL_PASSWORD ?? "",
    });

    const id = activity.id;
    const userId = activity.athlete.id;
    const startLat = activity.start_latlng[0];
    const startLong = activity.start_latlng[1];
    const distance = activity.distance;
    const startTime = new Date(activity.start_date).toISOString();

    await connection.execute(
        "INSERT INTO Activity (id, userId, startLat, startLong, distance, coords, startTime) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            id,
            userId,
            startLat,
            startLong,
            distance,
            JSON.stringify(coordinates),
            startTime.slice(0, 19).replace("T", " "),
        ]
    );
};

export default saveActivity;
