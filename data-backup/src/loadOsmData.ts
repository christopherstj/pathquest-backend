import mysql from "mysql2/promise";
import OSMPeak from "../typeDefs/OSMPeak";
import fs from "fs";

const loadOsmData = async () => {
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

    await connection.query(
        "INSERT INTO Peak (Id, `Name`, Lat, `Long`, Altitude, State, Country) VALUES ?",
        [peaks.map(mapFunc)]
    );

    console.log(`Inserted ${peaks.length} peaks into database`);
};

export default loadOsmData;
