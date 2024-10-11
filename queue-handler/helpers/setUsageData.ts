import StravaRateLimit from "../typeDefs/StravaRateLimit";
import getCloudSqlConnection from "./getCloudSqlConnection";

const setUsageData = async (headers: Headers) => {
    const limitHeader = headers.get("X-ReadRateLimit-Limit");
    const usageHeader = headers.get("X-ReadRateLimit-Usage");

    if (!limitHeader || !usageHeader) {
        return;
    }

    const [shortTermLimit, dailyLimit] = limitHeader.split(",");
    const [shortTermUsage, dailyUsage] = usageHeader.split(",");

    const connection = await getCloudSqlConnection();

    await connection.execute(
        `UPDATE StravaRateLimit SET shortTermLimit = ?, dailyLimit = ?, shortTermUsage = ?, dailyUsage = ?`,
        [shortTermLimit, dailyLimit, shortTermUsage, dailyUsage]
    );
};

export default setUsageData;
