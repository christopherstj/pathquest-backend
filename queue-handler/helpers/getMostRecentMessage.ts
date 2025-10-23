import QueueMessage from "../typeDefs/QueueMessage";
import dayjs from "dayjs";
import getCloudSqlConnection from "./getCloudSqlConnection";

const getMostRecentMessage = async (
    limit: number,
    callback: (messages: QueueMessage[]) => void
) => {
    const pool = await getCloudSqlConnection();
    const { rows } = await pool.query<QueueMessage>(
        `
        SELECT id, action, created, started, completed, json_data, is_webhook
        FROM event_queue
        WHERE (started IS NULL OR started < (CURRENT_TIMESTAMP - INTERVAL '15 minutes'))
            AND completed IS NULL
            AND attempts < 5
        ORDER BY priority ASC, created ASC
        LIMIT $1
    `,
        [limit]
    );
    if (rows.length === 0) {
        return null;
    }

    const messages = rows as QueueMessage[];

    await pool.query(
        `UPDATE event_queue
        SET started = $1,
            attempts = attempts + 1
        WHERE id = ANY($2::bigint[])`,
        [dayjs().format("YYYY-MM-DD HH:mm:ss"), messages.map((x) => x.id)]
    );

    callback(messages);
};

export default getMostRecentMessage;
