import getCloudSqlConnection from "./getCloudSqlConnection";

const deleteActivity = async (
    activityId: string,
    deleteManualPeaks: boolean
) => {
    const pool = await getCloudSqlConnection();

    await pool.query(`DELETE FROM activities WHERE id = $1`, [activityId]);

    if (deleteManualPeaks) {
        await pool.query(
            `DELETE FROM user_peak_manual WHERE activity_id = $1`,
            [activityId]
        );
    }
};

export default deleteActivity;
