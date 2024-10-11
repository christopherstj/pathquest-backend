import strava from "strava-v3";
import getStravaAccessToken from "./getStravaAccessToken";
import {
    StravaLatLngStream,
    StravaNumberStream,
} from "../typeDefs/StravaStream";
import processCoords from "./processCoords";
import saveActivitySummits from "./saveActivitySummits";
import StravaActivity from "../typeDefs/StravaActivity";
import saveActivity from "./saveActivity";
import getStravaDescription from "./getStravaDescription";
import setUsageData from "./setUsageData";
import { Connection } from "mysql2/promise";

const getStravaActivity = async (
    connection: Connection,
    id: number,
    userId: string
) => {
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

    await setUsageData(connection, activityRes.headers);

    const activity: StravaActivity = await activityRes.json();

    const streamResponse = await fetch(
        `https://www.strava.com/api/v3/activities/${id}/streams?keys=time,latlng&key_by_type=true`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        }
    );

    await setUsageData(connection, streamResponse.headers);

    const streams: {
        latlng?: StravaLatLngStream;
        time?: StravaNumberStream;
        distance: StravaNumberStream;
    } = await streamResponse.json();

    const coords = streams.latlng;
    const times = streams.time;

    if (coords && times) {
        const summittedPeaks = await processCoords(connection, coords.data);

        const peakDetails = summittedPeaks.map((peak) => {
            const peakId = peak.id;
            const timestamp = new Date(
                new Date(activity.start_date).getTime() +
                    times.data[peak.index] * 1000
            );
            return { peakId, timestamp, activityId: id };
        });

        await saveActivity(connection, activity, coords.data);

        if (peakDetails.length > 0) {
            await saveActivitySummits(connection, peakDetails, id.toString());
        }

        const description = await getStravaDescription(
            connection,
            userId,
            activity.description?.split("⛰️ PathQuest")[0].trimEnd() ?? "",
            peakDetails
        );

        return description;
    }
};

export default getStravaActivity;
