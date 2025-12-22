import { Pool, PoolClient } from "pg";
import * as crypto from "crypto";
import * as cheerio from "cheerio";
import {
    ChallengeDefinition,
    ChallengeImportResult,
    MatchResult,
} from "../typeDefs/ChallengeImport";
import getCloudSqlConnection from "./getCloudSqlConnection";

interface InsertOptions {
    dryRun?: boolean;
    includeConfidence?: ("high" | "medium" | "low")[];
    createMissingPeaks?: boolean; // Create new peaks for "none" confidence matches
    updatePeakCoords?: boolean; // Update existing peak coordinates with external (Peakbagger) data
}

const DEFAULT_OPTIONS: InsertOptions = {
    dryRun: true,
    includeConfidence: ["high", "medium"],
    createMissingPeaks: true, // Default to creating missing peaks
    updatePeakCoords: false, // Default to not updating existing peak coords
};

/**
 * Generate a unique PathQuest peak ID
 * Format: pq{8-char-hex}
 */
const generatePqPeakId = (): string => {
    const hash = crypto.randomBytes(4).toString("hex");
    return `pq${hash}`;
};

/**
 * Fetch county from Peakbagger page if peakId is available
 */
const fetchCountyFromPeakbagger = async (peakId: string): Promise<string | null> => {
    try {
        const peakUrl = `https://peakbagger.com/peak.aspx?pid=${peakId}`;
        const response = await fetch(peakUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
        });

        if (!response.ok) return null;

        const html = await response.text();
        const $ = cheerio.load(html);

        // Look for table row with "County/Second Level Region" label
        let county: string | null = null;
        $("table tr").each((i, row) => {
            const cells = $(row).find("td");
            if (cells.length >= 2) {
                const label = $(cells[0]).text().trim();
                if (label.includes("County") || label.includes("Second Level Region")) {
                    county = $(cells[1]).text().trim().replace(/\s+/g, " ").trim();
                    return false; // Break out of loop
                }
            }
        });

        return county;
    } catch (error) {
        console.warn(`Error fetching county for peak ${peakId}:`, error);
        return null;
    }
};

/**
 * Create a new peak in the database from external data
 */
const createPeak = async (
    client: PoolClient,
    match: MatchResult,
    challengeRegion: string
): Promise<string> => {
    const peakId = generatePqPeakId();
    const { external } = match;

    // Parse state from region if possible (e.g., "California" -> "CA")
    const stateAbbreviations: Record<string, string> = {
        "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
        "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
        "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID",
        "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
        "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
        "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
        "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
        "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
        "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
        "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
        "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT",
        "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV",
        "Wisconsin": "WI", "Wyoming": "WY"
    };

    const state = stateAbbreviations[challengeRegion] || null;

    // Get county - use from external data if available, otherwise fetch from Peakbagger
    let county = external.county;
    if (!county && external.peakId) {
        county = await fetchCountyFromPeakbagger(external.peakId) || undefined;
    }

    await client.query(
        `INSERT INTO peaks (id, name, location_coords, elevation, state, country, county)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
            peakId,
            external.name,
            external.lng,
            external.lat,
            external.elevation,
            state,
            "United States", // Assuming US for now
            county || null,
        ]
    );

    return peakId;
};

/**
 * Insert a challenge and its peak associations into the database
 */
export const insertChallenge = async (
    result: ChallengeImportResult,
    options: InsertOptions = DEFAULT_OPTIONS
): Promise<void> => {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const pool = await getCloudSqlConnection();

    console.log(`\n${"=".repeat(80)}`);
    console.log(`INSERTING CHALLENGE: ${result.challenge.name}`);
    console.log(`Mode: ${opts.dryRun ? "DRY RUN" : "LIVE"}`);
    console.log(`Including confidence levels: ${opts.includeConfidence?.join(", ")}`);
    console.log(`Create missing peaks: ${opts.createMissingPeaks ? "YES" : "NO"}`);
    console.log(`Update peak coords from external: ${opts.updatePeakCoords ? "YES" : "NO"}`);
    console.log("=".repeat(80));

    // Filter matches by confidence level (existing OSM peaks)
    // Exclude peaks marked with createNew (they'll be created as new peaks instead)
    const matchesToInsert = result.matches.filter(
        (m) => 
            !m.createNew && // Don't use matched peaks if createNew is true
            m.osmPeakId && 
            m.confidence !== "none" && 
            opts.includeConfidence?.includes(m.confidence as "high" | "medium" | "low")
    );

    // Get unmatched peaks that need to be created
    // Include: 1) peaks with no match (confidence === "none"), 2) peaks marked createNew
    const peaksToCreate = opts.createMissingPeaks
        ? result.matches.filter(
            (m) => 
                (m.confidence === "none" || m.createNew === true) && 
                m.external.lat && 
                m.external.lng
          )
        : [];

    console.log(`\nPeaks with OSM matches: ${matchesToInsert.length}`);
    console.log(`Peaks to create (no OSM match): ${peaksToCreate.length}`);
    console.log(`Total peaks: ${matchesToInsert.length + peaksToCreate.length} / ${result.matches.length}`);

    if (opts.dryRun) {
        console.log("\n[DRY RUN] Would execute the following:");
        console.log(`\n1. Insert challenge:`);
        console.log(`   ID: ${result.challenge.id}`);
        console.log(`   Name: ${result.challenge.name}`);
        console.log(`   Region: ${result.challenge.region}`);
        console.log(`   Center: (${result.challenge.centerLat}, ${result.challenge.centerLng})`);
        
        if (peaksToCreate.length > 0) {
            const createNewCount = result.matches.filter((m) => m.createNew).length;
            const noMatchCount = peaksToCreate.length - createNewCount;
            
            console.log(`\n2. Create ${peaksToCreate.length} new peaks:`);
            if (createNewCount > 0) {
                console.log(`   - ${createNewCount} marked createNew (incorrect match)`);
            }
            if (noMatchCount > 0) {
                console.log(`   - ${noMatchCount} no OSM match`);
            }
            
            for (const m of peaksToCreate.slice(0, 10)) {
                const reason = m.createNew ? "createNew" : "no match";
                console.log(`   + ${m.external.name} (${m.external.lat.toFixed(4)}, ${m.external.lng.toFixed(4)}) → pq{hash} [${reason}]`);
            }
            if (peaksToCreate.length > 10) {
                console.log(`   ... and ${peaksToCreate.length - 10} more`);
            }
        }

        console.log(`\n3. Insert ${matchesToInsert.length + peaksToCreate.length} peak associations`);
        
        // Show sample of matched peaks
        console.log(`\nSample matched peaks to insert:`);
        for (const m of matchesToInsert.slice(0, 10)) {
            console.log(`   - ${m.external.name} → OSM:${m.osmPeakId} (${m.confidence})`);
        }
        if (matchesToInsert.length > 10) {
            console.log(`   ... and ${matchesToInsert.length - 10} more`);
        }

        console.log(`\n[DRY RUN] No changes made. Run with dryRun: false to insert.`);
        return;
    }

    // Begin transaction
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Check if challenge already exists
        const existing = await client.query(
            "SELECT id FROM challenges WHERE id = $1",
            [result.challenge.id]
        );

        if (existing.rows.length > 0) {
            console.log(`\nChallenge ID ${result.challenge.id} already exists.`);
            console.log("Updating peak associations only...");
            
            // Delete existing associations
            await client.query(
                "DELETE FROM peaks_challenges WHERE challenge_id = $1",
                [result.challenge.id]
            );
        } else {
            // Insert challenge
            await client.query(
                `INSERT INTO challenges (id, name, region, location_coords, description)
                 VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6)`,
                [
                    result.challenge.id,
                    result.challenge.name,
                    result.challenge.region,
                    result.challenge.centerLng,
                    result.challenge.centerLat,
                    result.challenge.description,
                ]
            );
            console.log(`\n✓ Inserted challenge: ${result.challenge.name}`);
        }

        // Create new peaks for unmatched entries
        const createdPeakIds: Map<string, string> = new Map(); // external.name -> peakId
        if (peaksToCreate.length > 0) {
            console.log(`\nCreating ${peaksToCreate.length} new peaks...`);
            for (const match of peaksToCreate) {
                const peakId = await createPeak(client, match, result.challenge.region);
                createdPeakIds.set(match.external.name, peakId);
            }
            console.log(`✓ Created ${peaksToCreate.length} new peaks (pq{hash} IDs)`);
        }

        // Update existing peak coordinates with external (Peakbagger) data
        if (opts.updatePeakCoords && matchesToInsert.length > 0) {
            console.log(`\nUpdating ${matchesToInsert.length} peak coordinates from external data...`);
            let updated = 0;
            for (const match of matchesToInsert) {
                if (match.osmPeakId && match.external.lat && match.external.lng) {
                    await client.query(
                        `UPDATE peaks 
                         SET location_coords = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                             elevation = COALESCE($3, elevation)
                         WHERE id = $4`,
                        [
                            match.external.lng,
                            match.external.lat,
                            match.external.elevation || null,
                            match.osmPeakId,
                        ]
                    );
                    updated++;
                }
            }
            console.log(`✓ Updated ${updated} peak coordinates`);
        }

        // Combine all peak IDs for association
        const allPeakAssociations: { peakId: string; name: string }[] = [];

        // Add matched peaks
        for (const m of matchesToInsert) {
            if (m.osmPeakId) {
                allPeakAssociations.push({ peakId: m.osmPeakId, name: m.external.name });
            }
        }

        // Add newly created peaks
        for (const m of peaksToCreate) {
            const peakId = createdPeakIds.get(m.external.name);
            if (peakId) {
                allPeakAssociations.push({ peakId, name: m.external.name });
            }
        }

        // Insert peak associations in batches
        const BATCH_SIZE = 100;
        let inserted = 0;

        for (let i = 0; i < allPeakAssociations.length; i += BATCH_SIZE) {
            const batch = allPeakAssociations.slice(i, i + BATCH_SIZE);
            
            if (batch.length === 0) continue;

            // Build multi-row INSERT
            const values: any[] = [];
            const placeholders: string[] = [];

            for (let j = 0; j < batch.length; j++) {
                const p = batch[j];
                placeholders.push(`($${j * 2 + 1}, $${j * 2 + 2})`);
                values.push(p.peakId, result.challenge.id);
            }

            await client.query(
                `INSERT INTO peaks_challenges (peak_id, challenge_id) 
                 VALUES ${placeholders.join(", ")}
                 ON CONFLICT DO NOTHING`,
                values
            );

            inserted += batch.length;
            console.log(`✓ Inserted peak associations: ${inserted}/${allPeakAssociations.length}`);
        }

        await client.query("COMMIT");
        console.log(`\n✓ Successfully inserted challenge with ${inserted} peaks`);
        if (peaksToCreate.length > 0) {
            console.log(`  (${matchesToInsert.length} matched OSM peaks + ${peaksToCreate.length} new PQ peaks)`);
        }
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error inserting challenge:", error);
        throw error;
    } finally {
        client.release();
    }
};

/**
 * Get the next available challenge ID
 */
export const getNextChallengeId = async (): Promise<number> => {
    const pool = await getCloudSqlConnection();
    const result = await pool.query("SELECT MAX(id) as max_id FROM challenges");
    return (result.rows[0]?.max_id || 0) + 1;
};

/**
 * List existing challenges
 */
export const listExistingChallenges = async (): Promise<void> => {
    const pool = await getCloudSqlConnection();
    const result = await pool.query(`
        SELECT c.id, c.name, c.region, COUNT(pc.peak_id) as peak_count
        FROM challenges c
        LEFT JOIN peaks_challenges pc ON c.id = pc.challenge_id
        GROUP BY c.id, c.name, c.region
        ORDER BY c.id
    `);

    console.log("\n" + "=".repeat(80));
    console.log("EXISTING CHALLENGES");
    console.log("=".repeat(80));
    console.log(
        `\n${"ID".padStart(5)} | ${"Name".padEnd(40)} | ${"Region".padEnd(20)} | Peaks`
    );
    console.log("-".repeat(80));

    for (const row of result.rows) {
        console.log(
            `${String(row.id).padStart(5)} | ${row.name.padEnd(40).slice(0, 40)} | ${(row.region || "").padEnd(20).slice(0, 20)} | ${row.peak_count}`
        );
    }

    console.log("\n");
};

/**
 * Export match results to a JSON file for manual review/editing
 */
export const exportMatchResults = async (
    result: ChallengeImportResult,
    filePath: string
): Promise<void> => {
    const fs = await import("fs");
    
    const exportData = {
        challenge: result.challenge,
        stats: result.stats,
        matches: result.matches.map((m) => ({
            externalName: m.external.name,
            externalLat: m.external.lat,
            externalLng: m.external.lng,
            externalElevation: m.external.elevation,
            externalPeakId: m.external.peakId, // Peakbagger peak ID for re-fetching
            externalCounty: m.external.county, // County from Peakbagger
            osmPeakId: m.osmPeakId,
            osmName: m.osmName,
            osmElevation: m.osmElevation,
            distance: Math.round(m.distance),
            nameSimilarity: Math.round(m.nameSimilarity * 100),
            confidence: m.confidence,
            include: true, // Default to include (set to false to exclude)
            createNew: m.createNew || false, // Flag to create new peak even if matched
        })),
    };

    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));
    console.log(`\nExported match results to: ${filePath}`);
    console.log("Edit the 'include' field to manually exclude peaks.");
    console.log("Set 'createNew: true' for peaks that matched incorrectly (will create new peak instead).");
};

/**
 * Import match results from a JSON file (after manual review)
 */
export const importMatchResults = async (
    filePath: string
): Promise<ChallengeImportResult> => {
    const fs = await import("fs");
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    const matches: MatchResult[] = data.matches
        .filter((m: any) => {
            // Include if explicitly included, OR if it's an unmatched peak (will be created if createMissingPeaks is true)
            return m.include !== false || m.confidence === "none";
        })
        .map((m: any) => ({
            external: {
                name: m.externalName,
                lat: m.externalLat,
                lng: m.externalLng,
                elevation: m.externalElevation,
                peakId: m.externalPeakId, // Peakbagger peak ID
                county: m.externalCounty, // County from Peakbagger
            },
            osmPeakId: m.createNew ? null : m.osmPeakId, // If createNew, ignore the match
            osmName: m.createNew ? null : m.osmName,
            osmElevation: m.createNew ? null : m.osmElevation,
            distance: m.distance,
            nameSimilarity: m.nameSimilarity / 100,
            confidence: m.createNew ? "none" : m.confidence, // Treat as "none" if createNew
            createNew: m.createNew || false,
        }));

    return {
        challenge: data.challenge,
        matches,
        stats: {
            total: matches.length,
            highConfidence: matches.filter((m) => m.confidence === "high").length,
            mediumConfidence: matches.filter((m) => m.confidence === "medium").length,
            lowConfidence: matches.filter((m) => m.confidence === "low").length,
            noMatch: matches.filter((m) => m.confidence === "none").length,
        },
    };
};

export default insertChallenge;

