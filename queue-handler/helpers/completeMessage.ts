import dayjs from "dayjs";
import getCloudSqlConnection from "./getCloudSqlConnection";

const completeMessage = async (messageId: number, error?: string) => {
    const pool = await getCloudSqlConnection();
    if (!error) {
        await pool.query(
            `UPDATE event_queue SET completed = $1 WHERE id = $2`,
            [dayjs().format("YYYY-MM-DD HH:mm:ss"), messageId]
        );
    } else {
        await pool.query(
            `UPDATE event_queue SET started = NULL, completed = NULL, error = $1 WHERE id = $2`,
            [error, messageId]
        );
    }
};

export default completeMessage;
