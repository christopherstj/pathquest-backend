import { Pool, RowDataPacket } from "mysql2/promise";
import getCloudSqlConnection from "./getCloudSqlConnection";

const getShouldUpdateDescription = async (pool: Pool, userId: string) => {
    const connection = await pool.getConnection();
    const [userRows] = await pool.query<
        ({ updateDescription: boolean } & RowDataPacket)[]
    >(
        "SELECT updateDescription = 1 updateDescription FROM `User` WHERE id = ? LIMIT 1",
        [userId]
    );
    connection.release();

    if (userRows.length === 0) {
        return false;
    }

    const updateDescription = Boolean(userRows[0].updateDescription);

    return updateDescription;
};

export default getShouldUpdateDescription;
