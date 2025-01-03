import { Connection, Pool } from "mysql2/promise";
import { StravaCreds } from "../typeDefs/StravaCreds";

const saveStravaCreds = async (pool: Pool, creds: StravaCreds) => {
    const { userId, accessToken, refreshToken, accessTokenExpiresAt } = creds;

    const connection = await pool.getConnection();
    await connection.execute(
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
    connection.release();
};

export default saveStravaCreds;
