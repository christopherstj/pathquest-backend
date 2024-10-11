import { StravaCreds } from "../typeDefs/StravaCreds";
import StravaTokenResponse from "../typeDefs/StravaTokenResponse";
import { Connection, ResultSetHeader } from "mysql2/promise";
import saveStravaCreds from "./saveStravaCreds";

const clientId = process.env.STRAVA_CLIENT_ID ?? "";
const clientSecret = process.env.STRAVA_CLIENT_SECRET ?? "";

const getNewToken = async (
    connection: Connection,
    refreshToken: string,
    userId: string
) => {
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

    await saveStravaCreds(connection, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        accessTokenExpiresAt: data.expires_at,
        userId,
    });

    return data.access_token;
};

const getStravaAccessToken = async (connection: Connection, userId: string) => {
    const [rows] = await connection.execute<(StravaCreds & ResultSetHeader)[]>(
        `SELECT * FROM StravaToken WHERE userId = ${userId} LIMIT 1`
    );

    const creds = rows[0];

    const { accessToken, refreshToken, accessTokenExpiresAt } = creds;

    if (!refreshToken || refreshToken === "") {
        return null;
    } else if (!accessToken || accessToken === "") {
        return await getNewToken(connection, refreshToken, userId);
    } else if (
        accessTokenExpiresAt &&
        accessTokenExpiresAt * 1000 < new Date().getTime()
    ) {
        return await getNewToken(connection, refreshToken, userId);
    } else {
        return accessToken;
    }
};

export default getStravaAccessToken;