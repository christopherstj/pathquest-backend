import { RowDataPacket } from "mysql2/promise";
import getCloudSqlConnection from "./getCloudSqlConnection";

const getShouldUpdateDescription = async (userId: string) => {
    const connection = await getCloudSqlConnection();

    const [userRows] = await connection.query<
        ({ updateDescription: boolean } & RowDataPacket)[]
    >(
        "SELECT updateDescription = 1 updateDescription FROM `User` WHERE id = ? LIMIT 1",
        [userId]
    );

    await connection.end();

    if (userRows.length === 0) {
        return false;
    }

    const updateDescription = Boolean(userRows[0].updateDescription);

    return updateDescription;
};

export default getShouldUpdateDescription;
