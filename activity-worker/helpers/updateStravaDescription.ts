import { Connection } from "mysql2/promise";
import getStravaAccessToken from "./getStravaAccessToken";
import setUsageData from "./setUsageData";

const updateStravaDescription = async (
    connection: Connection,
    userId: string,
    activityId: number,
    description: string
) => {
    const token = await getStravaAccessToken(connection, userId);

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

    await setUsageData(connection, response.headers);

    if (!response.ok) {
        console.error(await response.text());
    }

    return response.ok;
};

export default updateStravaDescription;
