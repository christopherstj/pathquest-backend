import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import mysql, { Connection, PoolConnection } from "mysql2/promise";
import storage from "node-persist";

const connector = new Connector();

const getCloudSqlConnection = async () => {
    console.log("Getting cloud SQL connection");
    // await storage.init();
    const cachedConnection: PoolConnection = await storage.getItem(
        "cloudSqlConnection"
    );

    if (cachedConnection) {
        console.log("Using cached connection");
        return cachedConnection;
    } else {
        console.log("Retrieved client options");

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

            // storage.setItem("cloudSqlConnection", connection);

            // console.log("Stored connection");

            return connection;
        } else {
            const clientOpts = await connector.getOptions({
                instanceConnectionName:
                    process.env.INSTANCE_CONNECTION_NAME ?? "",
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
    }
};

export default getCloudSqlConnection;
