import dayjs from "dayjs";
import { Connection, Pool } from "mysql2/promise";

const setMessageStarted = async (pool: Pool, messageId: number) => {
    await pool.execute(`UPDATE EventQueue SET started = ? WHERE id = ?`, [
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        messageId,
    ]);
};

export default setMessageStarted;
