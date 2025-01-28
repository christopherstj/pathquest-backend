import { RowDataPacket } from "mysql2";
import QueueMessage from "../typeDefs/QueueMessage";
import { Connection, Pool } from "mysql2/promise";
import dayjs from "dayjs";

const getMostRecentMessage = async (
    pool: Pool,
    limit: number,
    callback: (messages: QueueMessage[]) => void
) => {
    const connection = await pool.getConnection();
    const [rows] = await connection.query<(QueueMessage & RowDataPacket)[]>(
        `
        SELECT id, \`action\`, created, started, completed, jsonData, isWebhook = 1 isWebhook FROM EventQueue
        WHERE started IS NULL AND completed IS NULL AND attempts < 5
        ORDER BY isWebhook DESC, created ASC
        LIMIT ?
    `,
        [limit]
    );
    if (rows.length === 0) {
        return null;
    }

    const messages = rows as QueueMessage[];

    await connection.execute(
        `UPDATE EventQueue SET started = '${dayjs().format(
            "YYYY-MM-DD HH:mm:ss"
        )}', attempts = attempts + 1 WHERE id IN (${messages
            .map((x) => x.id)
            .join(",")})`
    );

    connection.release();

    callback(messages);
};

export default getMostRecentMessage;
