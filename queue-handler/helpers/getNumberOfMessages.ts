import { RowDataPacket } from "mysql2";
import pool from "./getCloudSqlConnection";

const getNumberOfMessages = async (): Promise<number> => {
    const [rows] = await pool.query<({ count: number } & RowDataPacket)[]>(`
        SELECT COUNT(id) count FROM EventQueue
        WHERE started IS NULL AND completed IS NULL
        ORDER BY isWebhook DESC, created ASC
    `);

    return rows[0].count;
};

export default getNumberOfMessages;
