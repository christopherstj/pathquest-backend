import getCloudSqlConnection from "./getCloudSqlConnection";

const getStravaDescription = async (
    userId: string,
    previousDescription: string,
    summits: {
        peakId: string;
        timestamp: Date;
        activityId: number;
    }[]
) => {
    if (summits.length === 0) {
        return;
    }

    const pool = await getCloudSqlConnection();

    const { rows: userRows } = await pool.query<{
        update_description: boolean;
    }>("SELECT update_description FROM users WHERE id = $1", [userId]);

    const updateDescription = Boolean(userRows[0].update_description);

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
        const { rows } = await pool.query<{
            timestamp: string;
            name: string;
            elevation: number;
        }>(
            `
            SELECT ap.timestamp, p.name, p.elevation FROM activities_peaks ap
                LEFT JOIN peaks p ON ap.peak_id = p.id
                LEFT JOIN activities a ON ap.activity_id = a.id
                LEFT JOIN users u ON a.user_id = u.id
                WHERE ap.peak_id = $1
                AND u.id = $2
        `,
            [summit.id, userId]
        );
        return {
            id: summit,
            name: rows[0].name,
            elevation: rows[0].elevation,
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
    }, `${previousDescription ? `${previousDescription}\n\n` : ""}⛰️ PathQuest.app\nMountains summited:\n`);

    return stravaDesc;
};

export default getStravaDescription;
