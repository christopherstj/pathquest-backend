import { Connection, Pool } from "mysql2/promise";
import getStravaAccessToken from "./getStravaAccessToken";
import setUsageData from "./setUsageData";

const updateStravaDescription = async (
    pool: Pool,
    userId: string,
    activityId: number,
    description: string
) => {
    const token = await getStravaAccessToken(pool, userId);

    const responseRaw = await fetch(
        `https://www.strava.com/api/v3/activities/${activityId}?description=${encodeURIComponent(
            description
        )}`,
        {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    const response = responseRaw.clone();

    await setUsageData(pool, response.headers);

    if (!response.ok) {
        console.error(await response.text());
    }

    return response.ok;
};

export default updateStravaDescription;
