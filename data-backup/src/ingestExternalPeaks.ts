import { Pool } from "pg";
import { randomUUID } from "crypto";
import { ExternalPeak } from "../typeDefs/ChallengeImport";
import { ExternalMatchOutputs, OneToOneMatch, loadReviewedMatches } from "./matchExternalPeaksOneToOne";

type IngestOptions = {
    source: string;
    setElevationFromSource: boolean;
    setSeedCoordsFromSource: boolean;
    /** If true, updates the peak's primary location (location_coords + location_geom) from the external source. */
    setPrimaryCoordsFromSource?: boolean;
    elevationSourceLabel: string;
    /** Path to the review JSON file (will process approved=true entries) */
    reviewFilePath?: string;
    /** What to do with rejected (approved=false) entries: 'skip' | 'insert' (default: skip) */
    rejectedAction?: "skip" | "insert";
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

const hasTable = async (pool: Pool, table: string): Promise<boolean> => {
    const { rows } = await pool.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = $1
        ) AS exists
    `,
        [table]
    );
    return Boolean(rows[0]?.exists);
};

const linkExternalId = async (pool: Pool, peakId: string, source: string, externalId: string) => {
    await pool.query(
        `
        INSERT INTO peak_external_ids (peak_id, source, external_id)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
    `,
        [peakId, source, externalId]
    );
};

// Cached schema info (populated once per run)
let schemaCache: {
    hasLocationGeom: boolean;
    hasSeedCoords: boolean;
    hasPublicLandsChecked: boolean;
    hasPeaksPublicLandsTable: boolean;
    hasElevationSource: boolean;
} | null = null;

const getSchemaCache = async (pool: Pool) => {
    if (schemaCache) return schemaCache;
    const [hasLocationGeom, hasSeedCoords, hasPublicLandsChecked, hasPeaksPublicLandsTable, hasElevationSource] =
        await Promise.all([
            hasColumn(pool, "peaks", "location_geom"),
            hasColumn(pool, "peaks", "seed_coords"),
            hasColumn(pool, "peaks", "public_lands_checked"),
            hasTable(pool, "peaks_public_lands"),
            hasColumn(pool, "peaks", "elevation_source"),
        ]);
    schemaCache = { hasLocationGeom, hasSeedCoords, hasPublicLandsChecked, hasPeaksPublicLandsTable, hasElevationSource };
    return schemaCache;
};

const updatePeakPrimaryCoords = async (pool: Pool, peakId: string, lng: number, lat: number) => {
    const schema = await getSchemaCache(pool);

    const setParts: string[] = [
        `location_coords = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography`,
    ];
    if (schema.hasLocationGeom) {
        setParts.push(`location_geom = ST_SetSRID(ST_MakePoint($1, $2), 4326)`);
    }
    if (schema.hasSeedCoords) {
        setParts.push(`seed_coords = ST_SetSRID(ST_MakePoint($1, $2), 4326)`);
    }
    // Also reset public_lands_checked in the same UPDATE if the column exists
    if (schema.hasPublicLandsChecked) {
        setParts.push(`public_lands_checked = FALSE`);
    }

    await pool.query(
        `
        UPDATE peaks
        SET ${setParts.join(", ")}
        WHERE id = $3
    `,
        [lng, lat, peakId]
    );

    // Delete stale public-lands rows if the table exists
    if (schema.hasPeaksPublicLandsTable) {
        await pool.query(`DELETE FROM peaks_public_lands WHERE peak_id = $1`, [peakId]);
    }
};

const maybeUpdatePeakElevation = async (
    pool: Pool,
    peakId: string,
    elevationMeters: number,
    elevationSource: string
) => {
    if (!Number.isFinite(elevationMeters) || elevationMeters <= 0) return;
    const schema = await getSchemaCache(pool);
    if (schema.hasElevationSource) {
        await pool.query(
            `UPDATE peaks SET elevation = $1, elevation_source = $2 WHERE id = $3`,
            [elevationMeters, elevationSource, peakId]
        );
    } else {
        await pool.query(`UPDATE peaks SET elevation = $1 WHERE id = $2`, [elevationMeters, peakId]);
    }
};

const insertNewPeak = async (pool: Pool, external: ExternalPeak, opts: IngestOptions): Promise<string> => {
    if (!external.externalId) {
        throw new Error(`Cannot insert without externalId (${opts.source}): ${external.name}`);
    }

    // Idempotency: if externalId already linked, return existing peak_id
    const { rows: existing } = await pool.query<{ peak_id: string }>(
        `
        SELECT peak_id
        FROM peak_external_ids
        WHERE source = $1
          AND external_id = $2
        LIMIT 1
    `,
        [opts.source, external.externalId]
    );
    if (existing.length > 0) return existing[0].peak_id;

    const id = randomUUID();
    const schema = await getSchemaCache(pool);

    const columns: string[] = ["id", "name", "location_coords", "source_origin", "seed_coords"];
    const valuesSql: string[] = [
        "$1",
        "$2",
        "ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography",
        "$5",
        "ST_SetSRID(ST_MakePoint($3, $4), 4326)",
    ];
    const params: any[] = [id, external.name, external.lng, external.lat, opts.source];

    if (schema.hasLocationGeom) {
        columns.push("location_geom");
        valuesSql.push("ST_SetSRID(ST_MakePoint($3, $4), 4326)");
    }

    if (opts.setElevationFromSource && external.elevation && external.elevation > 0) {
        columns.push("elevation", "elevation_source");
        valuesSql.push("$6", "$7");
        params.push(external.elevation, opts.elevationSourceLabel);
    }

    const insertSql = `
        INSERT INTO peaks (${columns.join(", ")})
        VALUES (${valuesSql.join(", ")})
    `;

    await pool.query(insertSql, params);
    await linkExternalId(pool, id, opts.source, external.externalId);
    return id;
};

/** Helper to link a match (used for both high-confidence and approved reviews) */
const linkMatch = async (
    pool: Pool,
    m: OneToOneMatch,
    opts: IngestOptions
): Promise<void> => {
    if (!m.external.externalId) return;
    await linkExternalId(pool, m.peakId, opts.source, m.external.externalId);

    if (opts.setPrimaryCoordsFromSource) {
        await updatePeakPrimaryCoords(pool, m.peakId, m.external.lng, m.external.lat);
    }

    if (opts.setSeedCoordsFromSource) {
        await pool.query(
            `
            UPDATE peaks
            SET seed_coords = ST_SetSRID(ST_MakePoint($1, $2), 4326)
            WHERE id = $3
        `,
            [m.external.lng, m.external.lat, m.peakId]
        );
    }

    if (opts.setElevationFromSource && m.external.elevation && m.external.elevation > 0) {
        await maybeUpdatePeakElevation(pool, m.peakId, m.external.elevation, opts.elevationSourceLabel);
    }
};

export default async function ingestExternalPeaks(
    pool: Pool,
    matchResult: ExternalMatchOutputs,
    options: Partial<Omit<IngestOptions, "source">> & { source: string }
): Promise<void> {
    const opts: IngestOptions = {
        setElevationFromSource: true,
        setSeedCoordsFromSource: false,
        setPrimaryCoordsFromSource: false,
        elevationSourceLabel: options.source,
        rejectedAction: "skip",
        ...options,
    };

    console.log(`\nApplying ingest for source=${opts.source}...`);

    // 1) Link matched-high
    console.log(`Linking matched-high: ${matchResult.matchedHigh.length}`);
    for (let i = 0; i < matchResult.matchedHigh.length; i++) {
        await linkMatch(pool, matchResult.matchedHigh[i], opts);
        if ((i + 1) % 50 === 0 || i + 1 === matchResult.matchedHigh.length) {
            console.log(`  Linked ${i + 1}/${matchResult.matchedHigh.length}`);
        }
    }

    // 2) Process reviewed matches (if review file provided)
    if (opts.reviewFilePath) {
        const { approved, rejected, pending } = loadReviewedMatches(opts.reviewFilePath);
        console.log(`\nReview file: ${opts.reviewFilePath}`);
        console.log(`  approved:  ${approved.length}`);
        console.log(`  rejected:  ${rejected.length}`);
        console.log(`  pending:   ${pending.length} (skipped)`);

        // Link approved
        console.log(`Linking approved reviews: ${approved.length}`);
        for (let i = 0; i < approved.length; i++) {
            await linkMatch(pool, approved[i], opts);
            if ((i + 1) % 25 === 0 || i + 1 === approved.length) {
                console.log(`  Linked ${i + 1}/${approved.length}`);
            }
        }

        // Handle rejected based on rejectedAction
        if (opts.rejectedAction === "insert" && rejected.length > 0) {
            console.log(`Inserting rejected reviews as new peaks: ${rejected.length}`);
            for (let i = 0; i < rejected.length; i++) {
                await insertNewPeak(pool, rejected[i].external, opts);
                if ((i + 1) % 25 === 0 || i + 1 === rejected.length) {
                    console.log(`  Inserted ${i + 1}/${rejected.length}`);
                }
            }
        } else if (rejected.length > 0) {
            console.log(`Skipping ${rejected.length} rejected reviews`);
        }
    }

    // 3) Insert unmatched
    console.log(`Inserting unmatched: ${matchResult.unmatched.length}`);
    for (let i = 0; i < matchResult.unmatched.length; i++) {
        const p = matchResult.unmatched[i];
        await insertNewPeak(pool, p, opts);
        if ((i + 1) % 50 === 0 || i + 1 === matchResult.unmatched.length) {
            console.log(`  Inserted ${i + 1}/${matchResult.unmatched.length}`);
        }
    }

    console.log(`Ingest complete for source=${opts.source}.`);
}


