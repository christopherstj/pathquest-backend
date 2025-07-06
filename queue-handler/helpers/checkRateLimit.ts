import { RowDataPacket } from "mysql2";
import StravaRateLimit from "../typeDefs/StravaRateLimit";
import getStravaAccessToken from "./getStravaAccessToken";
import setUsageData from "./setUsageData";
import pool from "./getCloudSqlConnection";

const checkRateLimit = async (checkStrava: boolean) => {
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

    const [rows] = await pool.query<(StravaRateLimit & RowDataPacket)[]>(`
        SELECT * FROM StravaRateLimit
    `);

    if (rows.length === 0) {
        return 0;
    }

    const rateLimit = rows[0];

    const shortTermAllowance =
        (rateLimit.shortTermLimit - rateLimit.shortTermUsage - 3) / 3;
    const dailyAllowance =
        (rateLimit.dailyLimit - rateLimit.dailyUsage - 10) / 3;

    const allowance = Math.floor(Math.min(shortTermAllowance, dailyAllowance));

    return allowance > 0 ? allowance : 0;
};

export default checkRateLimit;
