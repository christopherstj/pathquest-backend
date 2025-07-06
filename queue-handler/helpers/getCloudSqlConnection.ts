import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import mysql, { Pool } from "mysql2";

const pool: Pool = mysql.createPool({
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

const db = pool.promise();

export default db;
