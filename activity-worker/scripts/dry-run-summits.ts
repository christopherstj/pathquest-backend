import processCoords from "../helpers/processCoords";
import getCloudSqlConnection from "../helpers/getCloudSqlConnection";

const BATCH_LIMIT = 50;

const main = async () => {
    const pool = await getCloudSqlConnection();

    await pool.query(`
        CREATE TABLE IF NOT EXISTS summit_detection_dry_run (
            id SERIAL PRIMARY KEY,
            activity_id VARCHAR NOT NULL,
            peak_id VARCHAR NOT NULL,
            detection_index INT NOT NULL,
            detected_at TIMESTAMP,
            run_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`TRUNCATE TABLE summit_detection_dry_run`);

    const { rows } = await pool.query<{
        id: string;
        coords: string;
        time_stream: any;
        start_time: string;
    }>(`
        SELECT 
            id,
            ST_AsGeoJSON(coords::geometry) as coords,
            time_stream,
            start_time
        FROM activities
        ORDER BY start_time DESC
        LIMIT $1
    `, [BATCH_LIMIT]);

    for (const row of rows) {
        const geo = JSON.parse(row.coords);
        const coords = geo.coordinates as [number, number][];
        const times: number[] | undefined =
            row.time_stream && Array.isArray(row.time_stream)
                ? row.time_stream
                : row.time_stream?.data ?? undefined;

        const summits = await processCoords(coords, times);

        if (summits.length === 0) continue;

        const start = new Date(row.start_time).getTime();

        const insertValues = summits.map((s) => ({
            activity_id: row.id,
            peak_id: s.id,
            detection_index: s.index,
            detected_at:
                times && times[s.index] !== undefined
                    ? new Date(start + times[s.index] * 1000)
                    : null,
        }));

        const placeholders = insertValues
            .map(
                (_, i) =>
                    `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${
                        i * 4 + 4
                    })`
            )
            .join(", ");

        const flatValues = insertValues.flatMap((v) => [
            v.activity_id,
            v.peak_id,
            v.detection_index,
            v.detected_at,
        ]);

        await pool.query(
            `INSERT INTO summit_detection_dry_run (activity_id, peak_id, detection_index, detected_at)
             VALUES ${placeholders}`,
            flatValues
        );
    }

    console.log("Dry run complete. Results stored in summit_detection_dry_run.");
    process.exit(0);
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});


