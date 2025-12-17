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
import deleteActivity from "./deleteActivity";
import getHistoricalWeatherByCoords from "./getHistoricalWeatherByCoords";

const getStravaActivity = async (id: number, userId: string) => {
    const accessToken = await getStravaAccessToken(userId);

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

    await setUsageData(activityRes.headers);

    const activity: StravaActivity = await activityRes.json();

    // Blocklist of activity types that are not human-powered
    const EXCLUDED_SPORT_TYPES = [
        'AlpineSki',      // Lift-assisted downhill skiing
        'Snowboard',      // Lift-assisted downhill
        'Sail',           // Wind-powered
        'Windsurf',       // Wind-powered
        'Kitesurf',       // Wind-powered
        'VirtualRide',    // Indoor/simulated - no real summits
        'VirtualRun',     // Indoor/simulated - no real summits
        'Golf',           // Not relevant to peak bagging
        'Velomobile',     // Often aerodynamically assisted
    ];

    if (EXCLUDED_SPORT_TYPES.includes(activity.sport_type)) {
        console.log(`Skipping activity ${id}: sport_type ${activity.sport_type} is excluded`);
        return;
    }

    const streamResponseRaw = await fetch(
        `https://www.strava.com/api/v3/activities/${id}/streams?keys=time,latlng,altitude,distance&key_by_type=true`,
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

    await setUsageData(streamResponse.headers);

    const streams: {
        latlng?: StravaLatLngStream;
        time?: StravaNumberStream;
        altitude?: StravaNumberStream;
        distance?: StravaNumberStream;
    } = await streamResponse.json();

    const coords_raw = streams.latlng;
    const times = streams.time;
    const altitude = streams.altitude;
    const distance = streams.distance;

    if (coords_raw && times) {
        const coords = coords_raw.data.map(
            (point) => [point[1], point[0]] as [number, number]
        );

        const summittedPeaks = await processCoords(coords, times.data);

        const peakDetailsPromises = summittedPeaks.map(async (peak) => {
            const peakId = peak.id;
            const timestamp = new Date(
                new Date(activity.start_date).getTime() +
                    times.data[peak.index] * 1000
            );
            const weather = await getHistoricalWeatherByCoords(
                timestamp,
                { lat: peak.lat, lon: peak.lng },
                peak.elevation ?? 0
            );
            return { peakId, timestamp, activityId: id, weather };
        });

        const peakDetails = await Promise.all(peakDetailsPromises);

        await deleteActivity(id.toString(), false);

        await saveActivity(
            activity,
            coords,
            times.data,
            altitude?.data,
            distance?.data
        );

        const isPublic =
            activity.private === false || activity.private === "false";

        if (peakDetails.length > 0) {
            await saveActivitySummits(peakDetails, id.toString(), isPublic, activity.utc_offset || 0);
        }

        const description = await getStravaDescription(
            userId,
            activity.description?.split("⛰️ PathQuest.app")[0].trimEnd() ?? "",
            peakDetails
        );

        return description;
    }
};

export default getStravaActivity;
