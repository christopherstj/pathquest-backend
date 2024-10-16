import distanceMetersToDegrees from "./distanceMetersToDegrees";
import getBoundingBox from "./getBoundingBox";
import Peak from "../typeDefs/Peak";
import compareCoords from "./compareCoords";
import getSummits from "./getSummits";
import { Connection } from "mysql2/promise";

const processCoords = async (
    connection: Connection,
    coords: [number, number][]
) => {
    const initialCoords = coords[0];

    const delta = distanceMetersToDegrees(10, initialCoords[0]);

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
            minLat: initialCoords[0] - delta.lat,
            maxLat: initialCoords[0] + delta.lat,
            minLong: initialCoords[1] - delta.long,
            maxLong: initialCoords[1] + delta.long,
        }
    );

    const [rows] = await connection.execute(
        `SELECT * FROM Peak WHERE Lat BETWEEN ${boundingBox.minLat} AND ${boundingBox.maxLat} AND \`Long\` BETWEEN ${boundingBox.minLong} AND ${boundingBox.maxLong}`
    );

    const coordResults = coords.map(([lat, long], index) => {
        return (rows as Peak[])
            .filter((x) => compareCoords(x, lat, long, delta))
            .map((x) => ({
                id: x.Id,
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
