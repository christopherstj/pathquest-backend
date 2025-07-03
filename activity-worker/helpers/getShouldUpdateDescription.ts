import { Pool, RowDataPacket } from "mysql2/promise";

const getShouldUpdateDescription = async (pool: Pool, userId: string) => {
    const [userRows] = await pool.query<
        ({ updateDescription: boolean } & RowDataPacket)[]
    >(
        "SELECT updateDescription = 1 updateDescription FROM `User` WHERE id = ? LIMIT 1",
        [userId]
    );

    if (userRows.length === 0) {
        return false;
    }

    const updateDescription = Boolean(userRows[0].updateDescription);

    return updateDescription;
};

export default getShouldUpdateDescription;
