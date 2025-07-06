import dayjs from "dayjs";
import pool from "./getCloudSqlConnection";

const completeMessage = async (messageId: number, error?: string) => {
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
