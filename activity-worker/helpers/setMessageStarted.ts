import dayjs from "dayjs";
import { Connection } from "mysql2/promise";

const setMessageStarted = async (connection: Connection, messageId: number) => {
    await connection.execute(`UPDATE EventQueue SET started = ? WHERE id = ?`, [
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        messageId,
    ]);
};

export default setMessageStarted;
