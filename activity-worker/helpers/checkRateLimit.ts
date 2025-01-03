import { RowDataPacket } from "mysql2";
import StravaRateLimit from "../typeDefs/StravaRateLimit";
import { Connection, Pool } from "mysql2/promise";
import getStravaAccessToken from "./getStravaAccessToken";
import setUsageData from "./setUsageData";

const checkRateLimit = async (pool: Pool, checkStrava: boolean) => {
    if (checkStrava) {
        const accessToken = await getStravaAccessToken(pool, "22686051");

        const accountRes = await fetch(
            `https://www.strava.com/api/v3/athlete`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        await setUsageData(pool, accountRes.headers);
    }

    const connection = await pool.getConnection();

    const [rows] = await connection.query<(StravaRateLimit & RowDataPacket)[]>(`
        SELECT * FROM StravaRateLimit
    `);

    connection.release();

    if (rows.length === 0) {
        return 0;
    }

    const rateLimit = rows[0];

    const shortTermAllowance =
        (rateLimit.shortTermLimit - rateLimit.shortTermUsage) / 3;
    const dailyAllowance = (rateLimit.dailyLimit - rateLimit.dailyUsage) / 3;

    const allowance = Math.floor(Math.min(shortTermAllowance, dailyAllowance));

    return allowance > 0 ? allowance : 0;
};

export default checkRateLimit;
