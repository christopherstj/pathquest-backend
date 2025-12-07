import distanceMetersToDegrees from "./distanceMetersToDegrees";
import getBoundingBox from "./getBoundingBox";
import Peak from "../typeDefs/Peak";
import getCloudSqlConnection from "./getCloudSqlConnection";
import detectSummits from "./detectSummits";
import {
    ENTER_DISTANCE_METERS,
    MAX_CANDIDATE_PEAKS,
    SEARCH_RADIUS_METERS,
} from "./summitConfig";
import haversineDistanceMeters from "./haversineDistanceMeters";

const processCoords = async (
    coords: [number, number][],
    times?: number[]
) => {
    const pool = await getCloudSqlConnection();

    if (!coords || coords.length === 0) {
        return [];
    }

    const initialCoords = coords[0];

    const searchDelta = distanceMetersToDegrees(
        SEARCH_RADIUS_METERS,
        initialCoords[0]
    );

    const boundingBox: {
        minLat: number;
        maxLat: number;
        minLong: number;
        maxLong: number;
    } = coords.reduce(
        (
            acc: {
                minLat: number;
                maxLat: number;
                minLong: number;
                maxLong: number;
            },
            [lng, lat]
        ) => getBoundingBox(acc, [lng, lat], searchDelta),
        {
            minLat: initialCoords[1] - searchDelta.lat,
            maxLat: initialCoords[1] + searchDelta.lat,
            minLong: initialCoords[0] - searchDelta.long,
            maxLong: initialCoords[0] + searchDelta.long,
        }
    );

    const { rows } = await pool.query<Peak>(
        `SELECT 
            id, 
            name, 
            elevation, 
            state, 
            country,
            ST_Y(location_coords::geometry) as lat,
            ST_X(location_coords::geometry) as lng,
            location_coords
        FROM peaks 
        WHERE ST_Within(
            location_coords::geometry,
            ST_MakeEnvelope($1, $2, $3, $4, 4326)
        )`,
        [
            boundingBox.minLong,
            boundingBox.minLat,
            boundingBox.maxLong,
            boundingBox.maxLat,
        ]
    );

    const candidatePeaks = rows.slice(0, MAX_CANDIDATE_PEAKS);

    const points = coords.map(([lng, lat], index) => {
        const time = times?.[index] ?? index;
        return { lat, lng, index, time };
    });

    // Quick prefilter: remove peaks that are not near any point in bounding terms
    const bufferDelta = distanceMetersToDegrees(
        ENTER_DISTANCE_METERS,
        initialCoords[0]
    );
    const latBuffer = bufferDelta.lat;
    const lngBuffer = bufferDelta.long || searchDelta.long;

    const peaksNearTrack = candidatePeaks.filter((peak) =>
        points.some(
            (pt) =>
                Math.abs(peak.lat - pt.lat) <= latBuffer * 2 &&
                Math.abs(peak.lng - pt.lng) <= lngBuffer * 2
        )
    );

    let filteredPeaks = peaksNearTrack;
    if (filteredPeaks.length > MAX_CANDIDATE_PEAKS) {
        const ranked = filteredPeaks
            .map((peak) => {
                const minDist = Math.min(
                    ...points.map((pt) =>
                        haversineDistanceMeters(pt.lat, pt.lng, peak.lat, peak.lng)
                    )
                );
                return { peak, minDist };
            })
            .sort((a, b) => a.minDist - b.minDist)
            .slice(0, MAX_CANDIDATE_PEAKS)
            .map((x) => x.peak);
        filteredPeaks = ranked;
    }

    const summits = detectSummits(points, filteredPeaks);

    if (process.env.SUMMIT_DEBUG === "true") {
        console.log(
            `[summits] points=${points.length} candidates=${filteredPeaks.length} detections=${summits.length}`
        );
    }

    return summits;
};

export default processCoords;
