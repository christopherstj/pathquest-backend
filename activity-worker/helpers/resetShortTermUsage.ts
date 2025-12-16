import getCloudSqlConnection from "./getCloudSqlConnection";

const resetShortTermUsage = async () => {
    const pool = await getCloudSqlConnection();
    await pool.query(`UPDATE strava_rate_limits SET short_term_usage = 0`);
};

export default resetShortTermUsage;
