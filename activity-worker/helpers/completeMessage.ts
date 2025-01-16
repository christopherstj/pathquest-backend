import dayjs from "dayjs";
import { Connection, Pool } from "mysql2/promise";

const completeMessage = async (
    pool: Pool,
    messageId: number,
    error?: string
) => {
    if (!error) {
        await pool.execute(`UPDATE EventQueue SET completed = ? WHERE id = ?`, [
            dayjs().format("YYYY-MM-DD HH:mm:ss"),
            messageId,
        ]);
    } else {
        await pool.execute(
            `UPDATE EventQueue SET started = NULL, completed = NULL, error = ? WHERE id = ?`,
            [error, messageId]
        );
    }
};

export default completeMessage;
