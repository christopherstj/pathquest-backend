import pool from "./getCloudSqlConnection";

const resetShortTermUsage = async () => {
    await pool.query(`UPDATE StravaRateLimit SET shortTermUsage = 0`);
};

export default resetShortTermUsage;
