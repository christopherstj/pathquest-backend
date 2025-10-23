import dayjs from "dayjs";
import getCloudSqlConnection from "./getCloudSqlConnection";

const setMessageStarted = async (messageId: number) => {
    const pool = await getCloudSqlConnection();
    await pool.query(`UPDATE event_queue SET started = $1 WHERE id = $2`, [
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        messageId,
    ]);
};

export default setMessageStarted;
