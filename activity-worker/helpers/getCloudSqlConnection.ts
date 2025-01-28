import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import mysql, { Connection, Pool, PoolConnection } from "mysql2/promise";

const connector = new Connector();

var globalPool: Pool | undefined = undefined;

const getCloudSqlConnection = async () => {
    console.log("Getting cloud SQL connection");

    if (globalPool) {
        return globalPool;
    }

    if (process.env.NODE_ENV === "production") {
        const pool = mysql.createPool({
            user: "local-user",
            password: process.env.MYSQL_PASSWORD,
            database: "dev-db",
            socketPath: "/cloudsql/" + process.env.INSTANCE_CONNECTION_NAME,
            timezone: "+00:00",
            charset: "utf8mb4",
            waitForConnections: true,
            connectTimeout: 20_000,
            idleTimeout: 600_000,
        });

        pool.on("connection", (connection: PoolConnection) => {
            connection.on("error", (err) => {
                console.error("Connection error", err);
                if (err.code === "PROTOCOL_CONNECTION_LOST") {
                    console.log("Reconnecting");
                    getCloudSqlConnection();
                }
            });
        });

        globalPool = pool;

        console.log("Created connection");

        return pool;
    } else {
        const clientOpts = await connector.getOptions({
            instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME ?? "",
            ipType: IpAddressTypes.PUBLIC,
        });

        const pool = await mysql.createPool({
            user: "local-user",
            password: process.env.MYSQL_PASSWORD,
            database: "dev-db",
            connectTimeout: 20_000,
            idleTimeout: 600_000,
            timezone: "+00:00",
            charset: "utf8mb4",
            ...clientOpts,
        });

        globalPool = pool;

        console.log("Created pool");

        return pool;
    }
};

export default getCloudSqlConnection;
