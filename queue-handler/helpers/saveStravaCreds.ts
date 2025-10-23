import { StravaCreds } from "../typeDefs/StravaCreds";
import getCloudSqlConnection from "./getCloudSqlConnection";

const saveStravaCreds = async (creds: StravaCreds) => {
    const pool = await getCloudSqlConnection();

    const { user_id, access_token, refresh_token, access_token_expires_at } =
        creds;

    await pool.query(
        `INSERT INTO strava_tokens 
        (user_id, access_token, refresh_token, access_token_expires_at) 
        VALUES ($1, $2, $3, $4) 
        ON CONFLICT (user_id) DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, access_token_expires_at = EXCLUDED.access_token_expires_at`,
        [user_id, access_token, refresh_token, access_token_expires_at]
    );
};

export default saveStravaCreds;
