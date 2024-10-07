import { config } from "dotenv";
config();
import mysql from "mysql2/promise";
import fs from "fs";
import distanceMetersToDegrees from "./helpers/distanceMetersToDegrees";
import Peak from "./typeDefs/Peak";

const main = async () => {
    const coords: [number, number][] = JSON.parse(
        fs.readFileSync("./src/coords.json", "utf8")
    );

    const connection = await mysql.createConnection({
        host: "127.0.0.1",
        user: "local-user",
        database: "dev-db",
        password: process.env.MYSQL_PASSWORD ?? "",
    });

    const initialCoords = coords[0];

    const delta = distanceMetersToDegrees(30, initialCoords[0]);

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
        ) => {
            return {
                minLat: Math.min(acc.minLat, lat - delta.lat),
                maxLat: Math.max(acc.maxLat, lat + delta.lat),
                minLong: Math.min(acc.minLong, long - delta.long),
                maxLong: Math.max(acc.maxLong, long + delta.long),
            };
        },
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

    const coordResults = coords.map(([lat, long]) => {
        return (rows as Peak[])
            .filter((x) => {
                if (
                    x.Lat >= lat - delta.lat &&
                    x.Lat <= lat + delta.lat &&
                    x.Long >= long - delta.long &&
                    x.Long <= long + delta.long
                ) {
                    return true;
                }
            })
            .map((x) => x.Id);
    });

    const taggedSummits = coordResults.reduce(
        (prev, curr, currIndex) => {
            curr.forEach((peakId) => {
                if (prev[peakId]) {
                    if (
                        prev[peakId].reset &&
                        currIndex > prev[peakId].lastIndex + 300
                    ) {
                        prev[peakId] = {
                            count: prev[peakId].count + 1,
                            reset: false,
                            lastIndex: currIndex,
                        };
                    } else {
                        prev[peakId].lastIndex = currIndex;
                    }
                } else if (!prev[peakId]) {
                    prev[peakId] = {
                        count: 1,
                        reset: false,
                        lastIndex: currIndex,
                    };
                }
            });
            Object.keys(prev).forEach((key) => {
                if (!curr.find((x) => x === key)) {
                    prev[key].reset = true;
                }
            });
            return prev;
        },
        {} as {
            [key: string]: {
                count: number;
                reset: boolean;
                lastIndex: number;
            };
        }
    );

    Object.keys(taggedSummits).forEach((key) => {
        const peak = (rows as Peak[]).find((x) => x.Id === key);
        if (peak) {
            console.log(
                `${peak.Name} has been tagged ${taggedSummits[key].count} time${
                    taggedSummits[key].count === 1 ? "" : "s"
                }`
            );
        }
    });
};

main().catch(console.error);
