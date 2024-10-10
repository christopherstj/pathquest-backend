import mysql from "mysql2/promise";

const saveActivitySummits = async (
    summits: {
        peakId: string;
        timestamp: Date;
        activityId: number;
    }[],
    activityId: string
) => {
    const connection = await mysql.createConnection({
        host: "127.0.0.1",
        user: "local-user",
        database: "dev-db",
        password: process.env.MYSQL_PASSWORD ?? "",
    });

    await connection.query(
        `INSERT INTO ActivityPeak (id, activityId, peakId, timestamp) VALUES ?`,
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
