import getStravaAccessToken from "./getStravaAccessToken";
import setUsageData from "./setUsageData";

const updateStravaDescription = async (
    userId: string,
    activityId: number,
    description: string
) => {
    const token = await getStravaAccessToken(userId);

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

    await setUsageData(response.headers);

    if (!response.ok) {
        console.error(await response.text());
    }

    return response.ok;
};

export default updateStravaDescription;
