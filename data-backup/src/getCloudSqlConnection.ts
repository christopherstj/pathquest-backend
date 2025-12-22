import { Pool } from "pg";

let globalPool: Pool | undefined = undefined;

const getCloudSqlConnection = async (): Promise<Pool> => {
    if (globalPool) return globalPool;

    const user = process.env.PG_USER ?? "local-user";
    const password =
        process.env.PG_PASSWORD ?? process.env.MYSQL_PASSWORD ?? "";
    const database = process.env.PG_DATABASE ?? "operations";

    // Use Unix domain socket path when INSTANCE_CONNECTION_NAME is set (Cloud Run / GCE)
    // This is more reliable than checking NODE_ENV, which may not be set in Cloud Run
    const instanceConnectionName = process.env.INSTANCE_CONNECTION_NAME;
    if (instanceConnectionName) {
        const socketPath = "/cloudsql/" + instanceConnectionName;

        const pool = new Pool({
            user,
            password,
            database,
            host: socketPath,
            port: 5432,
            max: 10,
        });

        // quick smoke-test
        await pool.query("SELECT 1");

        globalPool = pool;
        return pool;
    }

    // Local/dev: connect to local Postgres (or Cloud SQL Proxy listening on 127.0.0.1)
    const pool = new Pool({
        user,
        password,
        database,
        host: process.env.PG_HOST ?? "127.0.0.1",
        port: parseInt(process.env.PG_PORT ?? "5432", 10),
        max: 5,
    });

    // quick smoke-test
    await pool.query("SELECT 1");

    globalPool = pool;
    return pool;
};

export default getCloudSqlConnection;
