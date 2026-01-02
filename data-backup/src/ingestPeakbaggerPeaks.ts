import { Pool } from "pg";
import { randomUUID } from "crypto";
import { ExternalPeak } from "../typeDefs/ChallengeImport";
import { PeakbaggerMatchOutputs } from "./matchPeakbaggerPeaksOneToOne";

type IngestOptions = {
    setSeedCoordsFromPeakbagger: boolean;
    setElevationFromPeakbagger: boolean;
};

const hasColumn = async (pool: Pool, table: string, column: string): Promise<boolean> => {
    const { rows } = await pool.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = $1
              AND column_name = $2
        ) AS exists
    `,
        [table, column]
    );
    return Boolean(rows[0]?.exists);
};

const linkPeakbaggerId = async (pool: Pool, peakId: string, peakbaggerId: string) => {
    await pool.query(
        `
        INSERT INTO peak_external_ids (peak_id, source, external_id)
        VALUES ($1, 'peakbagger', $2)
        ON CONFLICT DO NOTHING
    `,
        [peakId, peakbaggerId]
    );
};

const insertNewPeakFromPeakbagger = async (
    pool: Pool,
    external: ExternalPeak,
    opts: IngestOptions
): Promise<string> => {
    if (!external.peakId) {
        throw new Error(`Cannot insert Peakbagger peak without peakId: ${external.name}`);
    }

    // If the peakbagger id is already linked, bail early (idempotency).
    const { rows: existing } = await pool.query<{ peak_id: string }>(
        `
        SELECT peak_id
        FROM peak_external_ids
        WHERE source = 'peakbagger'
          AND external_id = $1
        LIMIT 1
    `,
        [external.peakId]
    );
    if (existing.length > 0) {
        return existing[0].peak_id;
    }

    const id = randomUUID();

    const includeLocationGeom = await hasColumn(pool, "peaks", "location_geom");

    const columns: string[] = ["id", "name", "location_coords", "source_origin", "seed_coords"];
    const valuesSql: string[] = [
        "$1",
        "$2",
        "ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography",
        "$5",
        "ST_SetSRID(ST_MakePoint($3, $4), 4326)",
    ];
    const params: any[] = [id, external.name, external.lng, external.lat, "peakbagger"];

    if (includeLocationGeom) {
        columns.push("location_geom");
        valuesSql.push("ST_SetSRID(ST_MakePoint($3, $4), 4326)");
    }

    if (opts.setElevationFromPeakbagger) {
        columns.push("elevation", "elevation_source");
        valuesSql.push("$6", "$7");
        params.push(external.elevation, "peakbagger");
    }

    const insertSql = `
        INSERT INTO peaks (${columns.join(", ")})
        VALUES (${valuesSql.join(", ")})
    `;

    await pool.query(insertSql, params);

    await linkPeakbaggerId(pool, id, external.peakId);

    return id;
};

export default async function ingestPeakbaggerPeaks(
    pool: Pool,
    matchResult: PeakbaggerMatchOutputs,
    options: Partial<IngestOptions> = {}
): Promise<void> {
    const opts: IngestOptions = {
        setSeedCoordsFromPeakbagger: false,
        setElevationFromPeakbagger: true,
        ...options,
    };

    console.log("\nApplying Peakbagger ingest...");

    // 1) Link matched-high peaks to Peakbagger IDs
    console.log(`Linking matched-high: ${matchResult.matchedHigh.length}`);
    for (let i = 0; i < matchResult.matchedHigh.length; i++) {
        const m = matchResult.matchedHigh[i];
        if (!m.externalPeakbaggerId) continue;

        await linkPeakbaggerId(pool, m.peakId, m.externalPeakbaggerId);

        if (opts.setSeedCoordsFromPeakbagger) {
            await pool.query(
                `
                UPDATE peaks
                SET seed_coords = ST_SetSRID(ST_MakePoint($1, $2), 4326)
                WHERE id = $3
            `,
                [m.external.lng, m.external.lat, m.peakId]
            );
        }

        if ((i + 1) % 100 === 0) {
            console.log(`Linked ${i + 1}/${matchResult.matchedHigh.length}`);
        }
    }

    // 2) Insert unmatched peaks
    console.log(`Inserting unmatched: ${matchResult.unmatched.length}`);
    for (let i = 0; i < matchResult.unmatched.length; i++) {
        const p = matchResult.unmatched[i];
        await insertNewPeakFromPeakbagger(pool, p, opts);

        if ((i + 1) % 100 === 0) {
            console.log(`Inserted ${i + 1}/${matchResult.unmatched.length}`);
        }
    }

    console.log("Peakbagger ingest complete.");
}


