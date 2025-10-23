import getCloudSqlConnection from "./getCloudSqlConnection";

const updateActivityVisibility = async (id: number, isPublic: boolean) => {
    const pool = await getCloudSqlConnection();

    await pool.query(`UPDATE activities SET is_public = $1 WHERE id = $2`, [
        isPublic ? 1 : 0,
        id.toString(),
    ]);

    await pool.query(
        `UPDATE activities_peaks SET is_public = $1 WHERE activity_id = $2`,
        [isPublic ? 1 : 0, id.toString()]
    );
    await pool.query(
        `UPDATE user_peak_manual SET is_public = $1 WHERE activity_id = $2`,
        [isPublic ? 1 : 0, id.toString()]
    );
};

export default updateActivityVisibility;
