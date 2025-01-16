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
import { Connection, Pool } from "mysql2/promise";

const getStravaActivity = async (pool: Pool, id: number, userId: string) => {
    const accessToken = await getStravaAccessToken(pool, userId);

    if (accessToken === "") {
        throw new Error("Strava access token not found");
    }

    const activityResRaw = await fetch(
        `https://www.strava.com/api/v3/activities/${id}?include_all_efforts=false`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        }
    );

    if (!activityResRaw.ok) {
        if (activityResRaw.status === 404) {
            console.log(`Activity ${id} not found`);
            return;
        } else {
            throw new Error(
                `Error fetching activity ${id}: ${activityResRaw.statusText}`
            );
        }
    }

    const activityRes = activityResRaw.clone();

    await setUsageData(pool, activityRes.headers);

    const activity: StravaActivity = await activityRes.json();

    const streamResponseRaw = await fetch(
        `https://www.strava.com/api/v3/activities/${id}/streams?keys=time,latlng,altitude&key_by_type=true`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        }
    );

    if (!streamResponseRaw.ok) {
        if (streamResponseRaw.status === 404) {
            console.log(`Activity streams for ${id} not found`);
            return;
        }
        throw new Error(
            `Error fetching activity streams for ${id}: ${streamResponseRaw.statusText}`
        );
    }

    const streamResponse = streamResponseRaw.clone();

    await setUsageData(pool, streamResponse.headers);

    const streams: {
        latlng?: StravaLatLngStream;
        time?: StravaNumberStream;
        altitude?: StravaNumberStream;
        // distance: StravaNumberStream;
    } = await streamResponse.json();

    const coords = streams.latlng;
    const times = streams.time;
    const altitude = streams.altitude;

    if (coords && times) {
        const summittedPeaks = await processCoords(pool, coords.data);

        console.log(summittedPeaks);

        const peakDetails = summittedPeaks.map((peak) => {
            const peakId = peak.id;
            const timestamp = new Date(
                new Date(activity.start_date).getTime() +
                    times.data[peak.index] * 1000
            );
            return { peakId, timestamp, activityId: id };
        });

        await saveActivity(pool, activity, coords.data, altitude?.data);

        if (peakDetails.length > 0) {
            await saveActivitySummits(pool, peakDetails, id.toString());
        }

        const description = await getStravaDescription(
            pool,
            userId,
            activity.description?.split("⛰️ PathQuest")[0].trimEnd() ?? "",
            peakDetails
        );

        return description;
    }
};

export default getStravaActivity;
