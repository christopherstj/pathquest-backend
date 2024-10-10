import { StravaCreds } from "../typeDefs/StravaCreds";
import mysql from "mysql2/promise";

const saveStravaCreds = async (creds: StravaCreds) => {
    const connection = await mysql.createConnection({
        host: "127.0.0.1",
        user: "local-user",
        database: "dev-db",
        password: process.env.MYSQL_PASSWORD ?? "",
    });

    const { userId, accessToken, refreshToken, accessTokenExpiresAt } = creds;

    await connection.execute(
        "INSERT INTO StravaToken (userId, accessToken, refreshToken, accessTokenExpiresAt) VALUES (?, ?, ?, ?)",
        [userId, accessToken, refreshToken, accessTokenExpiresAt]
    );
};

export default saveStravaCreds;
