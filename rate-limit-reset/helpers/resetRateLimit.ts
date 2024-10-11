import getCloudSqlConnection from "./getCloudSqlConnection";

const resetRateLimit = async () => {
    const connection = await getCloudSqlConnection();

    await connection.execute(
        "UPDATE StravaRateLimit SET shortTermUsage = 0, dailyUsage = 0"
    );
};

export default resetRateLimit;
