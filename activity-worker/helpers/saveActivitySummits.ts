import getCloudSqlConnection from "./getCloudSqlConnection";

const saveActivitySummits = async (
    summits: {
        peakId: string;
        timestamp: Date;
        activityId: number;
    }[],
    activityId: string,
    isPublic: boolean
) => {
    const pool = await getCloudSqlConnection();

    if (!summits || summits.length === 0) return;

    const placeholders: string[] = [];
    const values: any[] = [];

    summits.forEach((x, i) => {
        const base = i * 5;
        placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${
                base + 5
            })`
        );
        values.push(
            `${activityId}-${x.peakId}-${x.timestamp.toISOString()}`,
            activityId,
            x?.peakId,
            x.timestamp.toISOString().slice(0, 19).replace("T", " "),
            isPublic ? 1 : 0
        );
    });

    const sql = `
        INSERT INTO activities_peaks (id, activity_id, peak_id, timestamp, is_public)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (id) DO NOTHING
    `;

    await pool.query(sql, values);
};

export default saveActivitySummits;
