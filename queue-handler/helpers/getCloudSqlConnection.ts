import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { Cacheable } from "cacheable";
import mysql, { Connection } from "mysql2/promise";
import { Keyv } from "cacheable";
import memoize from "memoizee";

const cache = new Cacheable();

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

        cache.set("cloudSqlConnection", connection);

        return connection;
    }
};

export default getCloudSqlConnection;
