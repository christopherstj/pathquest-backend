import { config } from "dotenv";
config();
import mysql from "mysql2/promise";
import fs from "fs";
import distanceMetersToDegrees from "./helpers/distanceMetersToDegrees";
import Peak from "./typeDefs/Peak";
import compareCoords from "./helpers/compareCoords";
import getBoundingBox from "./helpers/getBoundingBox";
import getSummits from "./helpers/getSummits";
import Fastify from "fastify";

const fastify = Fastify({ logger: true });

fastify.post<{
    Body: {
        activityIds: string[];
    };
}>("/process", async (request, reply) => {
    const activityIds = request.body.activityIds as string[];
});

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

    const coordResults = coords.map(([lat, long]) => {
        return (rows as Peak[])
            .filter((x) => compareCoords(x, lat, long, delta))
            .map((x) => x.Id);
    });

    const taggedSummits = coordResults.reduce(
        getSummits,
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
