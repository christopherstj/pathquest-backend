import { config } from "dotenv";
config();

import getCloudSqlConnection from "../helpers/getCloudSqlConnection";
import processCoords from "../helpers/processCoords";

const activityId = "15336809938";

const main = async () => {
    const pool = await getCloudSqlConnection();

    const { rows } = await pool.query(`
        SELECT 
            id,
            ST_AsGeoJSON(coords::geometry) as coords,
            time_stream,
            vert_profile,
            start_time
        FROM activities
        WHERE id = $1
    `, [activityId]);

    if (rows.length === 0) {
        console.log(`Activity ${activityId} not found`);
        process.exit(1);
    }

    const activity = rows[0];
    const geo = JSON.parse(activity.coords);
    const coords = geo.coordinates as [number, number][];
    const times = Array.isArray(activity.time_stream) ? activity.time_stream : undefined;
    const altitudes = Array.isArray(activity.vert_profile) ? activity.vert_profile : undefined;

    console.log(`Activity ${activityId}:`);
    console.log(`  Coordinates: ${coords.length} points`);
    console.log(`  Times: ${times?.length ?? 0} points`);
    console.log(`  Altitudes: ${altitudes?.length ?? 0} points`);

    const summits = await processCoords(coords, times, altitudes);

    console.log(`\nDetected ${summits.length} summit(s):`);
    summits.forEach((summit, idx) => {
        console.log(`  ${idx + 1}. Peak ${summit.id}`);
        console.log(`     Confidence: ${summit.confidenceScore.toFixed(3)}`);
        console.log(`     Needs confirmation: ${summit.needsConfirmation}`);
        console.log(`     Location: ${summit.lat.toFixed(6)}, ${summit.lng.toFixed(6)}`);
        console.log(`     Index: ${summit.index}`);
    });

    await pool.end();
    process.exit(0);
};

main().catch(console.error);

