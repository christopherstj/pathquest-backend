import { StravaCreds } from "../typeDefs/StravaCreds";
import getCloudSqlConnection from "./getCloudSqlConnection";

const saveStravaCreds = async (creds: StravaCreds) => {
    const pool = await getCloudSqlConnection();
    const { user_id, access_token, refresh_token, access_token_expires_at } =
        creds;

    await pool.query(
        "INSERT INTO strava_tokens (userId, accessToken, refreshToken, accessTokenExpiresAt) VALUES ($1, $2, $3, $4) ON DUPLICATE KEY UPDATE accessToken = $2, refreshToken = $3, accessTokenExpiresAt = $4",
        [user_id, access_token, refresh_token, access_token_expires_at]
    );
};

export default saveStravaCreds;
