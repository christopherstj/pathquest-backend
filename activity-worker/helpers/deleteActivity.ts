import { Pool } from "mysql2/promise";

const deleteActivity = async (
    pool: Pool,
    activityId: string,
    deleteManualPeaks: boolean
) => {
    await pool.execute(`DELETE FROM Activity WHERE id = ?`, [activityId]);

    if (deleteManualPeaks) {
        await pool.execute(`DELETE FROM UserPeakManual WHERE activityId = ?`, [
            activityId,
        ]);
    }
};

export default deleteActivity;
