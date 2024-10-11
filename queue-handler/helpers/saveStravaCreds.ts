import { Connection } from "mysql2/promise";
import { StravaCreds } from "../typeDefs/StravaCreds";

const saveStravaCreds = async (connection: Connection, creds: StravaCreds) => {
    const { userId, accessToken, refreshToken, accessTokenExpiresAt } = creds;

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
};

export default saveStravaCreds;
