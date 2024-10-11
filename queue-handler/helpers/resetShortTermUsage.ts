import getCloudSqlConnection from "./getCloudSqlConnection";

const resetShortTermUsage = async () => {
    const connection = await getCloudSqlConnection();

    await connection.execute(`UPDATE StravaRateLimit SET shortTermUsage = 0`);
};

export default resetShortTermUsage;
