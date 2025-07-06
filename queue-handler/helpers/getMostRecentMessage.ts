import { RowDataPacket } from "mysql2";
import QueueMessage from "../typeDefs/QueueMessage";
import pool from "./getCloudSqlConnection";
import dayjs from "dayjs";

const getMostRecentMessage = async (
    limit: number,
    callback: (messages: QueueMessage[]) => void
) => {
    const [rows] = await pool.query<(QueueMessage & RowDataPacket)[]>(
        `
        SELECT id, \`action\`, created, started, completed, jsonData, isWebhook = 1 isWebhook FROM EventQueue
        WHERE (started IS NULL OR started < date_sub(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE)) AND completed IS NULL AND attempts < 5
        ORDER BY priority ASC, created ASC
        LIMIT ?
    `,
        [limit]
    );
    if (rows.length === 0) {
        return null;
    }

    const messages = rows as QueueMessage[];

    await pool.execute(
        `UPDATE EventQueue SET started = '${dayjs().format(
            "YYYY-MM-DD HH:mm:ss"
        )}', attempts = attempts + 1 WHERE id IN (${messages
            .map((x) => x.id)
            .join(",")})`
    );

    callback(messages);
};

export default getMostRecentMessage;
