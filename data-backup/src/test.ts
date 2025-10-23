import { Client } from "pg";

const test = async () => {
    const pgClient = new Client({
        user: "local-user",
        password: process.env.PG_PASSWORD ?? "",
        host: "127.0.0.1",
        port: 5432,
        database: "operations",
    });

    await pgClient.connect();

    const res = await pgClient.query<{
        name: string;
        lng: number;
        lat: number;
    }>(
        "SELECT name, ST_X(location_coords::geometry) AS lng, ST_Y(location_coords::geometry) AS lat FROM peaks LIMIT 10"
    );

    console.log(res.rows);
};

export default test;
