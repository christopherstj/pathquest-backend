import getCloudSqlConnection from "./getCloudSqlConnection";

const updateActivityTitle = async (id: number, newTitle: string) => {
    const pool = await getCloudSqlConnection();

    const { rows } = await pool.query<{ title_manually_updated: boolean }>(
        `
        SELECT title_manually_updated FROM Activity WHERE id = ? LIMIT 1
    `,
        [id.toString()]
    );

    const shouldUpdateTitle =
        rows.length > 0 && !rows[0].title_manually_updated;

    if (shouldUpdateTitle) {
        await pool.query(`UPDATE activities SET title = $1 WHERE id = $2`, [
            newTitle,
            id.toString(),
        ]);
    }
};

export default updateActivityTitle;
