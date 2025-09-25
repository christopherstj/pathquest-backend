import { Pool } from "mysql2/promise";

const updateActivityVisibility = async (
    pool: Pool,
    id: number,
    isPublic: boolean
) => {
    await pool.execute(`UPDATE Activity SET isPublic = ? WHERE id = ?`, [
        isPublic ? 1 : 0,
        id.toString(),
    ]);

    await pool.execute(
        `UPDATE ActivityPeak SET isPublic = ? WHERE activityId = ?`,
        [isPublic ? 1 : 0, id.toString()]
    );
    await pool.execute(
        `UPDATE UserPeakManual SET isPublic = ? WHERE activityId = ?`,
        [isPublic ? 1 : 0, id.toString()]
    );
};

export default updateActivityVisibility;
