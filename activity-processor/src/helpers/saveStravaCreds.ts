import { StravaCreds } from "../typeDefs/StravaCreds";
import getCloudSqlConnection from "./getCloudSqlConnection";

const saveStravaCreds = async (creds: StravaCreds) => {
    const connection = await getCloudSqlConnection();

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
