import { Connection, Pool } from "mysql2/promise";

const setUsageData = async (pool: Pool, headers: Headers) => {
    const limitHeader = headers.get("X-ReadRateLimit-Limit");
    const usageHeader = headers.get("X-ReadRateLimit-Usage");

    if (!limitHeader || !usageHeader) {
        return;
    }

    const [shortTermLimit, dailyLimit] = limitHeader.split(",");
    const [shortTermUsage, dailyUsage] = usageHeader.split(",");

    await pool.execute(
        `UPDATE StravaRateLimit SET shortTermLimit = ?, dailyLimit = ?, shortTermUsage = ?, dailyUsage = ? WHERE id = 1`,
        [shortTermLimit, dailyLimit, shortTermUsage, dailyUsage]
    );
};

export default setUsageData;
