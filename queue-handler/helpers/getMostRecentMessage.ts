import { RowDataPacket } from "mysql2";
import getCloudSqlConnection from "./getCloudSqlConnection";
import QueueMessage from "../typeDefs/QueueMessage";
import { Connection } from "mysql2/promise";

const getMostRecentMessage = async (
    connection: Connection
): Promise<QueueMessage | null> => {
    const [rows] = await connection.query<(QueueMessage & RowDataPacket)[]>(`
        SELECT id, \`action\`, created, started, completed, jsonData, isWebhook = 1 isWebhook FROM EventQueue
        WHERE started IS NULL AND completed IS NULL
        ORDER BY isWebhook DESC, created ASC
        LIMIT 1
    `);

    if (rows.length === 0) {
        return null;
    }

    return {
        ...rows[0],
        isWebhook: Boolean(rows[0].isWebhook),
    };
};

export default getMostRecentMessage;
