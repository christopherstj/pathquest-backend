import { RowDataPacket } from "mysql2";
import getCloudSqlConnection from "./getCloudSqlConnection";
import QueueMessage from "../typeDefs/QueueMessage";
import { Connection } from "mysql2/promise";

const getNumberOfMessages = async (connection: Connection): Promise<number> => {
    const [rows] = await connection.query<
        ({ count: number } & RowDataPacket)[]
    >(`
        SELECT COUNT(id) count FROM EventQueue
        WHERE started IS NULL AND completed IS NULL
        ORDER BY isWebhook DESC, created ASC
    `);

    return rows[0].count;
};

export default getNumberOfMessages;
