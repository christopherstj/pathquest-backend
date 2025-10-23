import mysql, { RowDataPacket } from "mysql2";
import { Pool } from "mysql2/promise";
import { Client } from "pg";
import Peak from "../typeDefs/Peak";

const CHUNK_SIZE = 4000;
const START_ROW = 19000;

const processChunk = async (mysqlPool: Pool, pgClient: Client, i: number) => {
    const offset = i * CHUNK_SIZE + START_ROW;
    const limit = CHUNK_SIZE;

    console.log(`Processing chunk ${i + 1}`);

    const [rows] = await mysqlPool.query<any[]>(
        "SELECT * FROM Peak LIMIT ? OFFSET ?",
        [limit, offset]
    );

    console.log(`Fetched ${rows.length} rows from MySQL`);

    for (const row of rows) {
        const res = await pgClient.query(
            `
            INSERT INTO peaks_old (Altitude, Country, County, Id, Lat, Lng, Name, State, Type)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
            [
                row.Altitude,
                row.Country,
                row.County,
                row.Id,
                row.Lat,
                row.Long,
                row.Name,
                row.State,
                row.Type,
            ]
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

    const result = await pgClient.query<Peak>(``);

    console.log("Connected to Postgres");

    const [rows] = await mysqlPool.query<
        ({
            numPeaks: number;
        } & RowDataPacket)[]
    >("SELECT COUNT(*) AS numPeaks FROM Peak");

    const numPeaks = rows[0].numPeaks - START_ROW;

    console.log(`Migrating ${numPeaks} peaks`);

    const chunks = Math.ceil(numPeaks / CHUNK_SIZE);

    for (let i = 0; i < chunks; i++) {
        await processChunk(mysqlPool, pgClient, i);
    }

    await mysqlPool.end();
    await pgClient.end();
};

export default mysqlToPsql;
