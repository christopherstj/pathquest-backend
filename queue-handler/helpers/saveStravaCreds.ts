import { StravaCreds } from "../typeDefs/StravaCreds";
import pool from "./getCloudSqlConnection";

const saveStravaCreds = async (creds: StravaCreds) => {
    const { userId, accessToken, refreshToken, accessTokenExpiresAt } = creds;

    await pool.query(
        "INSERT INTO StravaToken (userId, accessToken, refreshToken, accessTokenExpiresAt) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE accessToken = ?, refreshToken = ?, accessTokenExpiresAt = ?",
        [
            userId,
            accessToken,
            refreshToken,
            accessTokenExpiresAt,
            accessToken,
            refreshToken,
            accessTokenExpiresAt,
        ]
    );
};

export default saveStravaCreds;
