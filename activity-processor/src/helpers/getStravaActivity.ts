import strava from "strava-v3";
import getStravaAccessToken from "./getStravaAccessToken";
import { StravaLatLngStream, StravaTimeStream } from "../typeDefs/StravaStream";
import processCoords from "./processCoords";
import saveActivitySummits from "./saveActivitySummits";
import StravaActivity from "../typeDefs/StravaActivity";
import saveActivity from "./saveActivity";
import getStravaDescription from "./getStravaDescription";

const getStravaActivity = async (id: number, userId: string) => {
    const accessToken = await getStravaAccessToken(userId);

    if (accessToken === "") {
        throw new Error("Strava access token not found");
    }

    const activityRes = await fetch(
        `https://www.strava.com/api/v3/activities/${id}?include_all_efforts=false`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        }
    );

    const activity: StravaActivity = await activityRes.json();

    const streams: (StravaLatLngStream | StravaTimeStream)[] =
        await strava.streams.activity({
            id,
            types: "time,latlng",
            access_token: accessToken,
        });

    const coords = streams.find(
        (stream) => stream.type === "latlng"
    ) as StravaLatLngStream;
    const times = streams.find(
        (stream) => stream.type === "time"
    ) as StravaTimeStream;

    const summittedPeaks = await processCoords(coords.data);

    const peakDetails = summittedPeaks.map((peak) => {
        const peakId = peak.id;
        const timestamp = new Date(
            new Date(activity.start_date).getTime() +
                times.data[peak.index] * 1000
        );
        return { peakId, timestamp, activityId: id };
    });

    await saveActivity(activity, coords.data);

    if (peakDetails.length > 0) {
        await saveActivitySummits(peakDetails, id.toString());
    }

    const description = await getStravaDescription(userId, peakDetails);

    return description;
};

export default getStravaActivity;
