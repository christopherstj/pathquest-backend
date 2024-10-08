import { RowDataPacket } from "mysql2";
import getCloudSqlConnection from "./getCloudSqlConnection";

const getStravaDescription = async (
    userId: string,
    summits: {
        peakId: string;
        timestamp: Date;
        activityId: number;
    }[]
) => {
    if (summits.length === 0) {
        return;
    }

    const connection = await getCloudSqlConnection();

    const [userRows] = await connection.query<
        ({ updateDescription: boolean } & RowDataPacket)[]
    >("SELECT updateDescription FROM `User` WHERE id = ? LIMIT 1", [userId]);

    const updateDescription = userRows[0].updateDescription;

    if (!updateDescription) {
        return;
    }

    const mountainsSummited = summits.reduce(
        (
            prev,
            curr
        ): {
            id: string;
            activitySummits: number;
        }[] => {
            const existing = prev.find((x) => x.id === curr.peakId);
            if (existing) {
                existing.activitySummits++;
            } else {
                prev.push({
                    id: curr.peakId,
                    activitySummits: 1,
                });
            }
            return prev;
        },
        [] as {
            id: string;
            activitySummits: number;
        }[]
    );

    const promises = mountainsSummited.map(async (summit) => {
        const [rows] = await connection.query<
            ({
                timestamp: string;
                Name: string;
                Altitude: number;
            } & RowDataPacket)[]
        >(`
            SELECT ap.\`timestamp\`, p.\`Name\`, p.Altitude FROM ActivityPeak ap 
                LEFT JOIN Peak p ON ap.peakId = p.Id
                LEFT JOIN Activity a ON ap.activityId = a.id
                LEFT JOIN \`User\` u ON a.userId = u.id
                WHERE ap.peakId = ${summit.id}
                AND u.id = ${userId}
        `);
        return {
            id: summit,
            name: rows[0].Name,
            altitude: rows[0].Altitude,
            activitySummits: summit.activitySummits,
            lifetimeSummits: rows.length,
        };
    });

    const data = await Promise.all(promises);

    const stravaDesc = data.reduce((description, mountain) => {
        return description.concat(
            `${mountain.name}${
                mountain.activitySummits > 1
                    ? ` - ${mountain.activitySummits} summits`
                    : ""
            } (${mountain.lifetimeSummits} lifetime summit${
                mountain.lifetimeSummits > 1 ? "s" : ""
            })\n`
        );
    }, "⛰️ PathQuest\nMountains summited:\n");

    return stravaDesc;
};

export default getStravaDescription;
