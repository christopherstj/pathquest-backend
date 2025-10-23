import getCloudSqlConnection from "./getCloudSqlConnection";

const getShouldUpdateDescription = async (userId: string) => {
    const pool = await getCloudSqlConnection();

    const { rows: userRows } = await pool.query<{
        update_description: boolean;
    }>("SELECT update_description FROM users WHERE id = $1 LIMIT 1", [userId]);

    if (userRows.length === 0) {
        return false;
    }

    const updateDescription = Boolean(userRows[0].update_description);

    return updateDescription;
};

export default getShouldUpdateDescription;
