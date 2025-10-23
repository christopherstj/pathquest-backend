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
        `UPDATE strava_rate_limit SET short_term_limit = $1, daily_limit = $2, short_term_usage = $3, daily_usage = $4`,
        [shortTermLimit, dailyLimit, shortTermUsage, dailyUsage]
    );
};

export default setUsageData;
