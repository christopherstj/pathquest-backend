import dayjs from "dayjs";
import getCloudSqlConnection from "./getCloudSqlConnection";

const completeMessage = async (messageId: number, error?: string) => {
    const connection = await getCloudSqlConnection();
    await connection.execute(
        `UPDATE EventQueue SET completed = ?, error = ? WHERE id = ?`,
        [dayjs().format("YYYY-MM-DD HH:mm:ss"), error ?? null, messageId]
    );
};

export default completeMessage;
