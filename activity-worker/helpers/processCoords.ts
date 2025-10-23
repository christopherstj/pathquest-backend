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
            [lat, long]
        ) => getBoundingBox(acc, [lat, long], delta),
        {
            minLat: initialCoords[1] - delta.lat,
            maxLat: initialCoords[1] + delta.lat,
            minLong: initialCoords[0] - delta.long,
            maxLong: initialCoords[0] + delta.long,
        }
    );

    const { rows } = await pool.query<Peak>(
        `SELECT * FROM peaks WHERE ST_Within(
            location_coords,
            ST_MakeEnvelope(${boundingBox.minLong}, ${boundingBox.minLat}, ${boundingBox.maxLong}, ${boundingBox.maxLat}, 4326)
        ) = true`
    );

    const coordResults = coords.map(([lat, long], index) => {
        return (rows as Peak[])
            .filter((x) => compareCoords(x, lat, long, delta))
            .map((x) => ({
                id: x.id,
                index,
            }));
    });

    const taggedSummits = coordResults.reduce(
        getSummits,
        {} as {
            [key: string]: {
                reset: boolean;
                lastIndex: number;
                summits: {
                    index: number;
                }[];
            };
        }
    );

    return Object.keys(taggedSummits)
        .map((x) => {
            return taggedSummits[x].summits.map((y) => ({
                id: x,
                index: y.index,
            }));
        })
        .flatMap((x) => x);
};

export default processCoords;
