import mysql, { Connection, Pool } from "mysql2/promise";

const saveActivitySummits = async (
    pool: Pool,
    summits: {
        peakId: string;
        timestamp: Date;
        activityId: number;
    }[],
    activityId: string
) => {
    await pool.query(
        `INSERT IGNORE INTO ActivityPeak (id, activityId, peakId, timestamp) VALUES ?`,
        [
            summits.map((x) => [
                `${activityId}-${x.peakId}-${x.timestamp.toISOString()}`,
                activityId,
                x?.peakId,
                x.timestamp.toISOString().slice(0, 19).replace("T", " "),
            ]),
        ]
    );
};

export default saveActivitySummits;
