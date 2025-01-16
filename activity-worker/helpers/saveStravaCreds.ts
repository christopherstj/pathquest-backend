import { Connection, Pool } from "mysql2/promise";
import { StravaCreds } from "../typeDefs/StravaCreds";

const saveStravaCreds = async (pool: Pool, creds: StravaCreds) => {
    const { userId, accessToken, refreshToken, accessTokenExpiresAt } = creds;

    await pool.execute(
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
