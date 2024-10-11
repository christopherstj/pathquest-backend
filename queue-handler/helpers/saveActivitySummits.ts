import mysql, { Connection } from "mysql2/promise";
import getCloudSqlConnection from "./getCloudSqlConnection";

const saveActivitySummits = async (
    connection: Connection,
    summits: {
        peakId: string;
        timestamp: Date;
        activityId: number;
    }[],
    activityId: string
) => {
    await connection.query(
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
