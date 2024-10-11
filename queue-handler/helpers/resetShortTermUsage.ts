import { Connection } from "mysql2/promise";
import getCloudSqlConnection from "./getCloudSqlConnection";

const resetShortTermUsage = async (connection: Connection) => {
    await connection.execute(`UPDATE StravaRateLimit SET shortTermUsage = 0`);
};

export default resetShortTermUsage;
