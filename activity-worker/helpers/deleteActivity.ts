import { Pool } from "mysql2/promise";
import getCloudSqlConnection from "./getCloudSqlConnection";

const deleteActivity = async (
    pool: Pool,
    activityId: string,
    deleteManualPeaks: boolean
) => {
    const connection = await pool.getConnection();
    await connection.execute(`DELETE FROM Activity WHERE id = ?`, [activityId]);

    if (deleteManualPeaks) {
        await connection.execute(
            `DELETE FROM UserPeakManual WHERE activityId = ?`,
            [activityId]
        );
    }
    connection.release();
};

export default deleteActivity;
