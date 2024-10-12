import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { createCache } from "cache-manager";
import mysql, { Connection } from "mysql2/promise";

const cache = createCache();

const connector = new Connector();

const getCloudSqlConnection = async () => {
    const cachedConnection = await cache.get<Connection>("cloudSqlConnection");

    if (cachedConnection) {
        return cachedConnection;
    } else {
        const clientOpts = await connector.getOptions({
            instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME ?? "",
            ipType: IpAddressTypes.PUBLIC,
        });

        const connection = await mysql.createConnection({
            ...clientOpts,
            user: "local-user",
            password: process.env.MYSQL_PASSWORD,
            database: "dev-db",
        });

        return connection;
    }
};

export default getCloudSqlConnection;
