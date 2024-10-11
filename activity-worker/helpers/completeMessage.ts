import dayjs from "dayjs";
import { Connection } from "mysql2/promise";

const completeMessage = async (
    connection: Connection,
    messageId: number,
    error?: string
) => {
    if (!error) {
        await connection.execute(
            `UPDATE EventQueue SET completed = ? WHERE id = ?`,
            [dayjs().format("YYYY-MM-DD HH:mm:ss"), messageId]
        );
    } else {
        await connection.execute(
            `UPDATE EventQueue SET started = NULL, completed = NULL, error = ? WHERE id = ?`,
            [error, messageId]
        );
    }
};

export default completeMessage;
