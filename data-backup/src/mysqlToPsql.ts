import mysql, { RowDataPacket } from "mysql2";
import { Pool } from "mysql2/promise";
import { Client } from "pg";
import Peak from "../typeDefs/Peak";

const CHUNK_SIZE = 4000;
const START_ROW = 0;

const processChunk = async (mysqlPool: Pool, pgClient: Client, i: number) => {
    const offset = i * CHUNK_SIZE + START_ROW;
    const limit = CHUNK_SIZE;

    console.log(`Processing chunk ${i + 1}`);

    const [rows] = await mysqlPool.query<any[]>("SELECT * FROM PeakChallenge");

    console.log(`Fetched ${rows.length} rows from MySQL`);

    for (const row of rows) {
        const res = await pgClient.query(
            `
            INSERT INTO peaks_challenges (peak_id, challenge_id)
            VALUES ($1, $2)
        `,
            [row.PeakId, row.ChallengeId]
        );
    }
};

const mysqlToPsql = async () => {
    const pool = mysql.createPool({
        host: "127.0.0.1",
        user: "local-user",
        database: "dev-db",
        password: process.env.MYSQL_PASSWORD ?? "",
    });

    const mysqlPool = pool.promise();

    console.log("Connected to MySQL");

    const pgClient = new Client({
        user: "local-user",
        password: process.env.PG_PASSWORD ?? "",
        host: "127.0.0.1",
        port: 5432,
        database: "operations",
    });

    await pgClient.connect();

    // const [rows] = await mysqlPool.query<any[]>("SELECT * FROM Challenge");

    // console.log(`Fetched ${rows.length} rows from MySQL`);

    // for (const row of rows) {
    //     const res = await pgClient.query(
    //         `
    //         INSERT INTO challenges (id, name, region, location_coords, description)
    //         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6)
    //     `,
    //         [
    //             row.id,
    //             row.name,
    //             row.region,
    //             row.centerLong,
    //             row.centerLat,
    //             row.description,
    //         ]
    //     );
    // }

    const [rows2] = await mysqlPool.query<any[]>("SELECT * FROM PeakChallenge");

    console.log(`Fetched ${rows2.length} rows from MySQL`);

    for (const row of rows2) {
        const res = await pgClient.query(
            `
            INSERT INTO peaks_challenges (peak_id, challenge_id)
            VALUES ($1, $2)
        `,
            [row.peakId, row.challengeId]
        );
    }

    console.log("Data transfer complete.");

    await mysqlPool.end();
    await pgClient.end();
};

export default mysqlToPsql;
