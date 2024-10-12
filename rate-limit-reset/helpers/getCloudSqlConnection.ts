import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import mysql, { Connection, PoolConnection } from "mysql2/promise";
const connector = new Connector();

const getCloudSqlConnection = async () => {
    console.log("Getting cloud SQL connection");

    if (process.env.NODE_ENV === "production") {
        const pool = await mysql.createPool({
            user: "local-user",
            password: process.env.MYSQL_PASSWORD,
            database: "dev-db",
            socketPath: "/cloudsql/" + process.env.INSTANCE_CONNECTION_NAME,
        });

        console.log("Created pool");

        const connection = await pool.getConnection();

        console.log("Created connection");

        return connection;
    } else {
        const clientOpts = await connector.getOptions({
            instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME ?? "",
            ipType: IpAddressTypes.PUBLIC,
        });

        const pool = await mysql.createPool({
            user: "local-user",
            password: process.env.MYSQL_PASSWORD,
            database: "dev-db",
            ...clientOpts,
        });

        console.log("Created pool");

        const connection = await pool.getConnection();

        console.log("Created connection");

        return connection;
    }
};

export default getCloudSqlConnection;
