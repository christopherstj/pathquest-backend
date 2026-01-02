import { config } from "dotenv";
config();

import * as fs from "fs";
import getCloudSqlConnection from "./getCloudSqlConnection";

const RANKED_CHALLENGE_NAME = "Colorado Ranked 13ers";
const ALL_CHALLENGE_NAME = "Colorado 13ers";
const REGION = "Colorado";

interface RankedMeta {
    externalId: string;
    name: string;
    coRank: number | null;
    thirteenRank: number | null;
    range: string;
    elevationFeet: number;
}

export default async function create14ersChallenges(): Promise<void> {
    const rankedMetaFile = process.env.RANKED_META_FILE ?? "14ers-ranked-meta.json";
    const dryRun = process.env.DRY_RUN !== "false";

    console.log("\n" + "═".repeat(80));
    console.log("CREATE COLORADO 13ERS CHALLENGES (Ranked + Unranked)");
    console.log("═".repeat(80));
    console.log(`Dry run: ${dryRun ? "YES" : "NO"}`);

    // Check if ranked meta file exists
    if (!fs.existsSync(rankedMetaFile)) {
        console.log(`\nRanked meta file not found: ${rankedMetaFile}`);
        console.log(`Run this first: TASK=export-14ers-ranked npm run dev:once`);
        return;
    }

    const rankedMeta: RankedMeta[] = JSON.parse(fs.readFileSync(rankedMetaFile, "utf-8"));
    const rankedExternalIds = new Set(rankedMeta.map((m) => m.externalId));
    console.log(`\nLoaded ${rankedMeta.length} ranked peaks from ${rankedMetaFile}`);

    const pool = await getCloudSqlConnection();

    // Get all 14ers external IDs from the database
    const { rows: allLinked } = await pool.query<{ peak_id: string; external_id: string }>(
        `SELECT peak_id, external_id FROM peak_external_ids WHERE source = '14ers'`
    );
    console.log(`Found ${allLinked.length} peaks linked to 14ers source in database`);

    // Partition into ranked vs all
    const rankedPeakIds: string[] = [];
    const allPeakIds: string[] = [];

    for (const row of allLinked) {
        allPeakIds.push(row.peak_id);
        if (rankedExternalIds.has(row.external_id)) {
            rankedPeakIds.push(row.peak_id);
        }
    }

    console.log(`\nPartitioned peaks:`);
    console.log(`  Ranked: ${rankedPeakIds.length}`);
    console.log(`  All:    ${allPeakIds.length}`);

    if (dryRun) {
        console.log(`\nDry-run complete. To create challenges, run with DRY_RUN=false`);
        return;
    }

    // Challenge IDs (pre-created)
    const rankedChallengeId = 15; // Colorado Ranked 13ers
    const allChallengeId = 16;    // Colorado 13ers

    console.log(`\nUsing challenge IDs: Ranked=${rankedChallengeId}, All=${allChallengeId}`);

    // Clear existing peaks_challenges for these challenges (in case of re-run)
    await pool.query(`DELETE FROM peaks_challenges WHERE challenge_id = $1`, [rankedChallengeId]);
    await pool.query(`DELETE FROM peaks_challenges WHERE challenge_id = $1`, [allChallengeId]);
    console.log(`  Cleared existing peaks_challenges entries`);

    // Insert peaks_challenges for ranked
    if (rankedPeakIds.length > 0) {
        const rankedValues = rankedPeakIds.map((pid) => `('${pid}', ${rankedChallengeId})`).join(",\n");
        await pool.query(`INSERT INTO peaks_challenges (peak_id, challenge_id) VALUES ${rankedValues}`);
        console.log(`  Inserted ${rankedPeakIds.length} peaks into "${RANKED_CHALLENGE_NAME}"`);
    }

    // Insert peaks_challenges for all
    if (allPeakIds.length > 0) {
        const allValues = allPeakIds.map((pid) => `('${pid}', ${allChallengeId})`).join(",\n");
        await pool.query(`INSERT INTO peaks_challenges (peak_id, challenge_id) VALUES ${allValues}`);
        console.log(`  Inserted ${allPeakIds.length} peaks into "${ALL_CHALLENGE_NAME}"`);
    }

    console.log(`\n✅ Challenges created successfully!`);
    console.log(`   - ${RANKED_CHALLENGE_NAME}: ${rankedPeakIds.length} peaks`);
    console.log(`   - ${ALL_CHALLENGE_NAME}: ${allPeakIds.length} peaks`);
}

