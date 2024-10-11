import { RowDataPacket } from "mysql2";
import QueueMessage from "../typeDefs/QueueMessage";
import { Connection } from "mysql2/promise";
import dayjs from "dayjs";

const getMostRecentMessage = async (
    connection: Connection,
    callback: (message: QueueMessage) => void
) => {
    const [rows] = await connection.query<(QueueMessage & RowDataPacket)[]>(
        `
        SELECT id, \`action\`, created, started, completed, jsonData, isWebhook = 1 isWebhook FROM EventQueue
        WHERE started IS NULL AND completed IS NULL AND attmpts < 5
        ORDER BY isWebhook DESC, created ASC
        LIMIT 1
    `
    );
    if (rows.length === 0) {
        return null;
    }

    const message = rows[0];

    await connection.execute(
        `UPDATE EventQueue SET started = ?, attempts = attempts + 1 WHERE id = ?`,
        [dayjs().format("YYYY-MM-DD HH:mm:ss"), message.id]
    );

    callback(message);
};

export default getMostRecentMessage;
