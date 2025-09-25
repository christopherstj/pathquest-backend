import { Pool, RowDataPacket } from "mysql2/promise";

const updateActivityTitle = async (
    pool: Pool,
    id: number,
    newTitle: string
) => {
    const [rows] = await pool.execute<
        (RowDataPacket & { titleManuallyUpdated: boolean })[]
    >(
        `
        SELECT titleManuallyUpdated = 1 titleManuallyUpdated FROM Activity WHERE id = ? LIMIT 1
    `,
        [id.toString()]
    );

    const shouldUpdateTitle = rows.length > 0 && !rows[0].titleManuallyUpdated;

    if (shouldUpdateTitle) {
        await pool.execute(`UPDATE Activity SET \`name\` = ? WHERE id = ?`, [
            newTitle,
            id.toString(),
        ]);
    }
};

export default updateActivityTitle;
