import getCloudSqlConnection from "./getCloudSqlConnection";

const getNumberOfMessages = async (): Promise<number> => {
    const pool = await getCloudSqlConnection();

    const { rows } = await pool.query<{ count: number }>(`
        SELECT COUNT(id) count FROM event_queue
        WHERE started IS NULL AND completed IS NULL
    `);

    return rows[0].count;
};

export default getNumberOfMessages;
