import { config } from "dotenv";
config();
import fs from "fs";
import mysql from "mysql2/promise";
import OSMPeak from "../typeDefs/OSMPeak";
import Peak from "../typeDefs/Peak";

const main = async () => {
    const connection = await mysql.createConnection({
        host: "127.0.0.1",
        user: "local-user",
        database: "dev-db",
        password: process.env.MYSQL_PASSWORD ?? "",
    });

    const rawData: OSMPeak[] = JSON.parse(
        fs.readFileSync("./src/summits.json", "utf8")
    ).elements;

    const peaks = rawData.filter(
        (peak) => peak.tags.name && peak.lat && peak.lon && peak.id
    );

    const mapFunc = (peak: OSMPeak) => {
        const elevation = peak.tags.ele ? parseFloat(peak.tags.ele) : null;
        return [
            peak.id.toString(),
            peak.tags.name,
            peak.lat,
            peak.lon,
            elevation && !isNaN(elevation) ? elevation : null,
            peak.tags["is_in:state_code"] ?? null,
            peak.tags["is_in:country"] ?? null,
        ];
    };

    await connection.query("TRUNCATE TABLE Peak");

    await connection.query(
        "INSERT INTO Peak (Id, `Name`, Lat, `Long`, Altitude, State, Country) VALUES ?",
        [peaks.map(mapFunc)]
    );

    console.log(`Inserted ${peaks.length} peaks into database`);

    // const query = `
    //     [out:json];
    //     (
    //         node["natural"="volcano"](24.396308, -125.0, 49.384358, -66.93457);
    //         node["natural"="peak"](24.396308, -125.0, 49.384358, -66.93457);
    //     );
    //     out;
    // `;
    // const queryString = `data=${encodeURIComponent(query)}`;

    // const response = await fetch("https://overpass-api.de/api/interpreter", {
    //     method: "POST",
    //     body: queryString,
    // });

    // const data = await response.text();

    // fs.writeFileSync("./src/summits.json", data);
};

main().catch((error) => {
    console.error(error);
});
