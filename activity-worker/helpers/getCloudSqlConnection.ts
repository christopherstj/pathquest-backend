import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import mysql from "mysql2/promise";

const connector = new Connector();

const getCloudSqlConnection = async () => {
    const clientOpts = connector.getOptions({
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
};

export default getCloudSqlConnection;
