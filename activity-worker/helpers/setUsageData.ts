import getCloudSqlConnection from "./getCloudSqlConnection";

const setUsageData = async (headers: Headers) => {
    const pool = await getCloudSqlConnection();

    const limitHeader = headers.get("X-ReadRateLimit-Limit");
    const usageHeader = headers.get("X-ReadRateLimit-Usage");

    if (!limitHeader || !usageHeader) {
        return;
    }

    const [shortTermLimit, dailyLimit] = limitHeader.split(",");
    const [shortTermUsage, dailyUsage] = usageHeader.split(",");

    await pool.query(
        `UPDATE strava_rate_limits SET shortTermLimit = $1, dailyLimit = $2, shortTermUsage = $3, dailyUsage = $4 WHERE id = 1`,
        [shortTermLimit, dailyLimit, shortTermUsage, dailyUsage]
    );
};

export default setUsageData;
