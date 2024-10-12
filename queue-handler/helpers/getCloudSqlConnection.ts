import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { Cacheable } from "cacheable";
import mysql, { Connection } from "mysql2/promise";
import storage from "node-persist";

const connector = new Connector();

const getCloudSqlConnection = async () => {
    await storage.init();
    const cachedConnection: Connection = await storage.getItem(
        "cloudSqlConnection"
    );

    if (cachedConnection) {
        console.log("Using cached connection");
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

        storage.setItem("cloudSqlConnection", connection);

        return connection;
    }
};

export default getCloudSqlConnection;
