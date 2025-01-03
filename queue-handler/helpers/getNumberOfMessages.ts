import { RowDataPacket } from "mysql2";
import { Connection, Pool } from "mysql2/promise";

const getNumberOfMessages = async (pool: Pool): Promise<number> => {
    const connection = await pool.getConnection();
    const [rows] = await connection.query<
        ({ count: number } & RowDataPacket)[]
    >(`
        SELECT COUNT(id) count FROM EventQueue
        WHERE started IS NULL AND completed IS NULL
        ORDER BY isWebhook DESC, created ASC
    `);

    connection.release();

    return rows[0].count;
};

export default getNumberOfMessages;
