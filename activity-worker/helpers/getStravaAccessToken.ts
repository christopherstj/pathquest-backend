import { StravaCreds } from "../typeDefs/StravaCreds";
import StravaTokenResponse from "../typeDefs/StravaTokenResponse";
import saveStravaCreds from "./saveStravaCreds";
import getCloudSqlConnection from "./getCloudSqlConnection";

const clientId = process.env.STRAVA_CLIENT_ID ?? "";
const clientSecret = process.env.STRAVA_CLIENT_SECRET ?? "";

const getNewToken = async (refreshToken: string, userId: string) => {
    const response = await fetch(
        `https://www.strava.com/api/v3/oauth/token?client_id=${clientId}&client_secret=${clientSecret}&refresh_token=${refreshToken}&grant_type=refresh_token`,
        {
            method: "POST",
        }
    );

    if (!response.ok) {
        console.error("Failed to get new token", await response.text());
        return null;
    }

    const data: StravaTokenResponse = await response.json();

    await saveStravaCreds({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        access_token_expires_at: data.expires_at,
        user_id: userId,
    });

    return data.access_token;
};

const getStravaAccessToken = async (userId: string) => {
    const pool = await getCloudSqlConnection();

    const { rows } = await pool.query<StravaCreds>(
        `SELECT * FROM strava_tokens WHERE user_id = ${userId} LIMIT 1`
    );

    const creds = rows[0];

    const { access_token, refresh_token, access_token_expires_at } = creds;

    if (!refresh_token || refresh_token === "") {
        return null;
    } else if (!access_token || access_token === "") {
        console.log(`no access token for user ${userId}`);
        return await getNewToken(refresh_token, userId);
    } else if (
        access_token_expires_at &&
        access_token_expires_at * 1000 < new Date().getTime()
    ) {
        console.log(`token expired for user ${userId}`);
        return await getNewToken(refresh_token, userId);
    } else {
        return access_token;
    }
};

export default getStravaAccessToken;
