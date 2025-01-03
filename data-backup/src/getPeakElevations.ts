import mysql, { RowDataPacket } from "mysql2/promise";
import Peak from "../typeDefs/Peak";
import { AddressType, Client } from "@googlemaps/google-maps-services-js";

const client = new Client({});

const getPeakElevations = async () => {
    const connection = await mysql.createConnection({
        host: "127.0.0.1",
        user: "local-user",
        database: "dev-db",
        password: process.env.MYSQL_PASSWORD ?? "",
    });

    const [rows] = await connection.query<(Peak & RowDataPacket)[]>(
        "SELECT * FROM Peak WHERE Altitude IS NULL"
    );

    for (const peak of rows) {
        const elevationRes = await client.elevation({
            params: {
                locations: [{ lat: peak.Lat, lng: peak.Long }],
                key: process.env.GOOGLE_MAPS_API_KEY ?? "",
            },
        });

        if (
            elevationRes.data.status !== "OK" ||
            !elevationRes.data.results[0]?.elevation
        ) {
            console.error(
                `Failed to get elevation for peak ${peak.Id}: ${elevationRes.data.status}`
            );
            continue;
        }

        const elevation = elevationRes.data.results[0].elevation;

        await connection.execute("UPDATE Peak SET Altitude = ? WHERE Id = ?", [
            elevation,
            peak.Id,
        ]);

        console.log(`Updated elevation for peak ${peak.Id} to ${elevation}`);
    }

    await connection.end();

    console.log("All peaks updated");
};

export default getPeakElevations;
