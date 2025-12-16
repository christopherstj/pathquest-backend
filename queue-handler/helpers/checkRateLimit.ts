import StravaRateLimit from "../typeDefs/StravaRateLimit";
import getCloudSqlConnection from "./getCloudSqlConnection";
import getStravaAccessToken from "./getStravaAccessToken";
import setUsageData from "./setUsageData";

const checkRateLimit = async (checkStrava: boolean) => {
    const pool = await getCloudSqlConnection();

    if (checkStrava) {
        const accessToken = await getStravaAccessToken("22686051");

        const accountRes = await fetch(
            `https://www.strava.com/api/v3/athlete`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        await setUsageData(accountRes.headers);
    }

    const { rows } = await pool.query<StravaRateLimit>(`
        SELECT * FROM strava_rate_limits
    `);

    if (rows.length === 0) {
        return 0;
    }

    const rateLimit = rows[0];

    const shortTermAllowance =
        (rateLimit.short_term_limit - rateLimit.short_term_usage - 3) / 3;
    const dailyAllowance =
        (rateLimit.daily_limit - rateLimit.daily_usage - 10) / 3;

    const allowance = Math.floor(Math.min(shortTermAllowance, dailyAllowance));

    return allowance > 0 ? allowance : 0;
};

export default checkRateLimit;
