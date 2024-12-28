import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import mysql from "mysql2/promise";

const connector = new Connector();

const getCloudSqlConnection = async () => {
    console.log("Getting cloud SQL connection");

    if (process.env.NODE_ENV === "production") {
        const connection = await mysql.createConnection({
            user: "local-user",
            password: process.env.MYSQL_PASSWORD,
            database: "dev-db",
            socketPath: "/cloudsql/" + process.env.INSTANCE_CONNECTION_NAME,
            timezone: "+00:00",
        });

        console.log("Created connection");

        return connection;
    } else {
        const clientOpts = await connector.getOptions({
            instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME ?? "",
            ipType: IpAddressTypes.PUBLIC,
        });

        const connection = await mysql.createConnection({
            user: "local-user",
            password: process.env.MYSQL_PASSWORD,
            database: "dev-db",
            connectTimeout: 20000,
            idleTimeout: 600000,
            timezone: "+00:00",
            ...clientOpts,
        });

        console.log("Created connection");

        return connection;
    }
};

export default getCloudSqlConnection;
