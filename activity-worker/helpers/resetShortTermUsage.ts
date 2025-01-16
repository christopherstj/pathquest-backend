import { Connection, Pool } from "mysql2/promise";

const resetShortTermUsage = async (pool: Pool) => {
    await pool.execute(`UPDATE StravaRateLimit SET shortTermUsage = 0`);
};

export default resetShortTermUsage;
