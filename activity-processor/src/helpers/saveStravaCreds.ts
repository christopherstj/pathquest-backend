import { StravaCreds } from "../typeDefs/StravaCreds";
import getCloudSqlConnection from "./getCloudSqlConnection";

const saveStravaCreds = async (creds: StravaCreds) => {
    const connection = await getCloudSqlConnection();

    const { userId, accessToken, refreshToken, accessTokenExpiresAt } = creds;

    await connection.execute(
        "INSERT INTO StravaToken (userId, accessToken, refreshToken, accessTokenExpiresAt) VALUES (?, ?, ?, ?)",
        [userId, accessToken, refreshToken, accessTokenExpiresAt]
    );
};

export default saveStravaCreds;
