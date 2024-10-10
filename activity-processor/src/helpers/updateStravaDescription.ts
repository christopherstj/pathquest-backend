import getStravaAccessToken from "./getStravaAccessToken";

const updateStravaDescription = async (
    userId: string,
    activityId: number,
    description: string
) => {
    const token = await getStravaAccessToken(userId);

    const response = await fetch(
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

    return response.ok;
};

export default updateStravaDescription;
