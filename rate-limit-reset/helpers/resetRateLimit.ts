import { Pool } from "mysql2/promise";
import getCloudSqlConnection from "./getCloudSqlConnection";

const resetRateLimit = async (pool: Pool) => {
    const connection = await pool.getConnection();
    await connection.execute(
        "UPDATE StravaRateLimit SET shortTermUsage = 0, dailyUsage = 0"
    );
    connection.release();
};

export default resetRateLimit;
