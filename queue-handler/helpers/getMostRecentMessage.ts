import { RowDataPacket } from "mysql2";
import QueueMessage from "../typeDefs/QueueMessage";
import { Connection, Pool } from "mysql2/promise";
import dayjs from "dayjs";

const getMostRecentMessage = async (
    pool: Pool,
    callback: (message: QueueMessage) => void
) => {
    const connection = await pool.getConnection();
    const [rows] = await connection.query<(QueueMessage & RowDataPacket)[]>(
        `
        SELECT id, \`action\`, created, started, completed, jsonData, isWebhook = 1 isWebhook FROM EventQueue
        WHERE started IS NULL AND completed IS NULL AND attempts < 5
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

    connection.release();

    callback(message);
};

export default getMostRecentMessage;
