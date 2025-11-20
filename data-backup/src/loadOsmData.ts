import mysql from "mysql2/promise";
import fs from "fs";
import { Client } from "pg";

interface GeoJSON {
    type: string;
    features: Array<{
        type: string;
        id: string;
        properties: {
            [key: string]: any;
        };
        geometry: {
            type: string;
            coordinates: number[];
        };
    }>;
}

const loadOsmData = async () => {
    const pgClient = new Client({
        user: "local-user",
        password: process.env.PG_PASSWORD ?? "",
        host: "127.0.0.1",
        port: 5432,
        database: "operations",
    });

    const rawData: GeoJSON = JSON.parse(
        fs.readFileSync("peaks-volcanoes.geojson", "utf8")
    );

    await pgClient.connect();

    if (rawData.features.length === 0) {
        console.log("No peaks to insert");
        return;
    }

    const BATCH_SIZE = 1000;
    const totalFeatures = rawData.features.length;
    let inserted = 0;

    console.log(
        `Processing ${totalFeatures} peaks in batches of ${BATCH_SIZE}...`
    );

    for (let offset = 0; offset < totalFeatures; offset += BATCH_SIZE) {
        const batch = rawData.features.slice(offset, offset + BATCH_SIZE);

        // Build multi-row INSERT with PostGIS geography point for location_coords
        const placeholders: string[] = [];
        const values: any[] = [];

        batch.forEach((feature) => {
            const properties = feature.properties;

            if (
                !feature.id ||
                !feature.geometry.coordinates ||
                !properties.name
            ) {
                return;
            }

            const base = values.length;

            // lon, lat order for PostGIS (coordinates[0] = lon, coordinates[1] = lat)
            placeholders.push(
                `($${base + 1}, $${base + 2}, ST_SetSRID(ST_MakePoint($${
                    base + 3
                }, $${base + 4}), 4326)::geography, $${base + 5}, $${
                    base + 6
                }, $${base + 7}, $${base + 8})`
            );

            values.push(
                feature.id.substring(1, feature.id.length), // remove leading character (e.g., 'n12345' -> '12345')
                properties["name:en"] ??
                    properties.int_name ??
                    properties.name ??
                    null,
                feature.geometry.coordinates[0], // longitude
                feature.geometry.coordinates[1], // latitude
                properties.ele && !isNaN(parseFloat(properties.ele))
                    ? parseFloat(properties.ele)
                    : null,
                properties["is_in:state_code"] ?? null,
                properties["is_in:country"] ?? null,
                properties
            );
        });

        if (placeholders.length === 0) {
            console.log(`Skipping empty batch at offset ${offset}`);
            continue;
        }

        const sql = `
            INSERT INTO peaks (id, name, location_coords, elevation, state, country, osm_object)
            VALUES ${placeholders.join(", ")}
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                location_coords = EXCLUDED.location_coords,
                state = EXCLUDED.state,
                country = EXCLUDED.country,
                osm_object = EXCLUDED.osm_object
        `;

        await pgClient.query(sql, values);
        inserted += batch.length;

        console.log(
            `Inserted ${inserted}/${totalFeatures} peaks (${Math.round(
                (inserted / totalFeatures) * 100
            )}%)`
        );
    }

    console.log(`✓ Successfully inserted ${totalFeatures} peaks into database`);
};

export default loadOsmData;
