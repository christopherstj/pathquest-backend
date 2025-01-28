import { Connection, Pool } from "mysql2/promise";

const resetShortTermUsage = async (pool: Pool) => {
    const connection = await pool.getConnection();
    await connection.execute(`UPDATE StravaRateLimit SET shortTermUsage = 0`);
    connection.release();
};

export default resetShortTermUsage;
