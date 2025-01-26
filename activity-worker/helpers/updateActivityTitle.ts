import { Pool, RowDataPacket } from "mysql2/promise";

const updateActivityTitle = async (
    pool: Pool,
    id: number,
    newTitle: string
) => {
    const connection = await pool.getConnection();

    const [rows] = await connection.execute<
        (RowDataPacket & { titleManuallyUpdated: boolean })[]
    >(
        `
        SELECT titleManuallyUpdated = 1 titleManuallyUpdated FROM Activity WHERE id = ? LIMIT 1
    `,
        [id.toString()]
    );

    const shouldUpdateTitle = rows.length > 0 && !rows[0].titleManuallyUpdated;

    if (shouldUpdateTitle) {
        await connection.execute(`UPDATE Activity SET title = ? WHERE id = ?`, [
            newTitle,
            id.toString(),
        ]);
    }

    connection.release();
};

export default updateActivityTitle;
