import distanceMetersToDegrees from "./distanceMetersToDegrees";
import getBoundingBox from "./getBoundingBox";
import Peak from "../typeDefs/Peak";
import compareCoords from "./compareCoords";
import getSummits from "./getSummits";
import getCloudSqlConnection from "./getCloudSqlConnection";

const processCoords = async (coords: [number, number][]) => {
    const pool = await getCloudSqlConnection();

    const initialCoords = coords[0];

    const delta = distanceMetersToDegrees(40, initialCoords[0]);

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
        ) => getBoundingBox(acc, [lng, lat], delta),
        {
            minLat: initialCoords[1] - delta.lat,
            maxLat: initialCoords[1] + delta.lat,
            minLong: initialCoords[0] - delta.long,
            maxLong: initialCoords[0] + delta.long,
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

    const coordResults = coords.map(([lng, lat], index) => {
        return (rows as Peak[])
            .filter((x) => compareCoords(x, lat, lng, delta))
            .map((x) => {
                const distanceToPeak = Math.sqrt(
                    Math.pow((x.lat - lat) * 111320, 2) +
                        Math.pow((x.lng - lng) * 111320, 2)
                );
                return {
                    id: x.id,
                    index,
                    lat,
                    lng,
                    elevation: x.elevation,
                    distanceToPeak,
                };
            });
    });

    const taggedSummits = coordResults.reduce(
        getSummits,
        {} as {
            [key: string]: {
                reset: boolean;
                lastIndex: number;
                lat: number;
                lng: number;
                elevation?: number;
                summits: {
                    index: number;
                    points: {
                        lat: number;
                        lng: number;
                        distanceToPeak: number;
                        index: number;
                    }[];
                }[];
            };
        }
    );

    // console.log(JSON.stringify(taggedSummits, null, 2));

    return Object.keys(taggedSummits)
        .map((x) => {
            return taggedSummits[x].summits.map((y) => {
                const closestIndex = y.points.reduce(
                    (closestIndex, point, index, arr) => {
                        if (
                            point.distanceToPeak <=
                            arr[closestIndex].distanceToPeak
                        ) {
                            return index;
                        }
                        return closestIndex;
                    },
                    0
                );
                return {
                    id: x,
                    lat: y.points[closestIndex].lat,
                    lng: y.points[closestIndex].lng,
                    elevation: taggedSummits[x].elevation,
                    index: y.points[closestIndex].index,
                };
            });
        })
        .flatMap((x) => x);
};

export default processCoords;
