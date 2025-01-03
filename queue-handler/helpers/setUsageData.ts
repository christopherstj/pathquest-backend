import { Connection, Pool } from "mysql2/promise";

const setUsageData = async (pool: Pool, headers: Headers) => {
    const limitHeader = headers.get("X-ReadRateLimit-Limit");
    const usageHeader = headers.get("X-ReadRateLimit-Usage");

    if (!limitHeader || !usageHeader) {
        return;
    }

    const [shortTermLimit, dailyLimit] = limitHeader.split(",");
    const [shortTermUsage, dailyUsage] = usageHeader.split(",");

    const connection = await pool.getConnection();
    await connection.execute(
        `UPDATE StravaRateLimit SET shortTermLimit = ?, dailyLimit = ?, shortTermUsage = ?, dailyUsage = ?`,
        [shortTermLimit, dailyLimit, shortTermUsage, dailyUsage]
    );
    connection.release();
};

export default setUsageData;
