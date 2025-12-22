/**
 * Main challenge import pipeline
 * 
 * Usage:
 *   1. Scrape from Peakbagger: Run with PEAKBAGGER_LIST_ID env var
 *   2. From JSON file: Run with PEAKS_JSON_FILE env var
 *   3. Review and insert: Run with REVIEW_FILE env var
 * 
 * Environment variables:
 *   - PEAKBAGGER_LIST_ID: Peakbagger list ID to scrape (e.g., "5061" for CO 13ers)
 *   - PEAKS_JSON_FILE: Path to JSON file with peak data
 *   - REVIEW_FILE: Path to exported review JSON file
 *   - CHALLENGE_ID: Override challenge ID (optional)
 *   - CHALLENGE_NAME: Override challenge name (optional)
 *   - CHALLENGE_REGION: Override challenge region (optional)
 *   - CHALLENGE_DESCRIPTION: Override challenge description (optional)
 *   - DRY_RUN: Set to "false" to actually insert (default: true)
 *   - INCLUDE_LOW_CONFIDENCE: Set to "true" to include low confidence matches
 *   - UPDATE_PEAK_COORDS: Set to "true" to update existing peak coords with Peakbagger data
 *   - RANKED_ONLY: Set to "true" to only include ranked peaks (peaks with a rank number)
 *   - CREATE_MISSING_PEAKS: Set to "false" to skip creating peaks for unmatched entries (default: true)
 */

import { config } from "dotenv";
config();

import {
    ExternalPeak,
    ChallengeDefinition,
    PEAKBAGGER_LISTS,
    PeakbaggerListConfig,
} from "../typeDefs/ChallengeImport";
import scrapePeakbaggerList, {
    loadPeaksFromJson,
    savePeaksToJson,
} from "./scrapePeakbaggerList";
import matchPeaksToOsm, {
    generateImportResult,
    printMatchReport,
} from "./matchPeaksToOsm";
import {
    insertChallenge,
    getNextChallengeId,
    listExistingChallenges,
    exportMatchResults,
    importMatchResults,
} from "./insertChallenge";

const importChallenge = async (): Promise<void> => {
    const listId = process.env.PEAKBAGGER_LIST_ID;
    const peaksJsonFile = process.env.PEAKS_JSON_FILE;
    const reviewFile = process.env.REVIEW_FILE;
    const dryRun = process.env.DRY_RUN !== "false";
    const includeLowConfidence = process.env.INCLUDE_LOW_CONFIDENCE === "true";
    const updatePeakCoords = process.env.UPDATE_PEAK_COORDS === "true";
    const rankedOnly = process.env.RANKED_ONLY === "true";
    const createMissingPeaks = process.env.CREATE_MISSING_PEAKS !== "false"; // Default to true

    console.log("\n" + "═".repeat(80));
    console.log("PATHQUEST CHALLENGE IMPORT PIPELINE");
    console.log("═".repeat(80));

    // Mode 1: Import from reviewed JSON file
    if (reviewFile) {
        console.log(`\nMode: Import from reviewed file`);
        console.log(`File: ${reviewFile}`);

        const result = await importMatchResults(reviewFile);
        printMatchReport(result);

        await insertChallenge(result, {
            dryRun,
            includeConfidence: includeLowConfidence
                ? ["high", "medium", "low"]
                : ["high", "medium"],
            updatePeakCoords,
            createMissingPeaks,
        });
        return;
    }

    // Get peaks from either Peakbagger or JSON file
    let peaks: ExternalPeak[];
    let listConfig: PeakbaggerListConfig | null = null;

    if (listId) {
        // Mode 2: Scrape from Peakbagger
        console.log(`\nMode: Scrape from Peakbagger`);
        
        // Find config by list ID
        listConfig = Object.values(PEAKBAGGER_LISTS).find(
            (c) => c.listId === listId
        ) || null;

        if (!listConfig) {
            // Create a generic config if not in predefined list
            listConfig = {
                listId,
                name: process.env.CHALLENGE_NAME || `Peakbagger List ${listId}`,
                region: process.env.CHALLENGE_REGION || "Unknown",
                description: process.env.CHALLENGE_DESCRIPTION || "",
            };
        }

        console.log(`List: ${listConfig.name}`);
        peaks = await scrapePeakbaggerList(listConfig, { rankedOnly });

        // Cache the scraped data
        const cacheFile = `peaks-${listId}.json`;
        await savePeaksToJson(peaks, cacheFile);
        console.log(`Cached peak data to: ${cacheFile}`);
    } else if (peaksJsonFile) {
        // Mode 3: Load from JSON file
        console.log(`\nMode: Load from JSON file`);
        console.log(`File: ${peaksJsonFile}`);
        peaks = await loadPeaksFromJson(peaksJsonFile);
    } else {
        // Show help and list existing challenges
        console.log(`\nNo input specified. Available options:`);
        console.log(`\n1. Scrape from Peakbagger:`);
        console.log(`   PEAKBAGGER_LIST_ID=5061 npm run dev:once`);
        console.log(`\n2. Load from JSON file:`);
        console.log(`   PEAKS_JSON_FILE=peaks.json npm run dev:once`);
        console.log(`\n3. Import from reviewed file:`);
        console.log(`   REVIEW_FILE=review.json npm run dev:once`);
        console.log(`\nPredefined Peakbagger lists:`);
        for (const [key, config] of Object.entries(PEAKBAGGER_LISTS)) {
            console.log(`   ${key}: ${config.name} (ID: ${config.listId})`);
        }
        console.log();
        await listExistingChallenges();
        return;
    }

    if (peaks.length === 0) {
        console.error("No peaks found!");
        return;
    }

    // Match peaks to OSM database
    const matches = await matchPeaksToOsm(peaks);

    // Calculate center point from peaks
    const centerLat =
        peaks.reduce((sum, p) => sum + p.lat, 0) / peaks.length;
    const centerLng =
        peaks.reduce((sum, p) => sum + p.lng, 0) / peaks.length;

    // Build challenge definition
    const challengeId =
        parseInt(process.env.CHALLENGE_ID || "") || (await getNextChallengeId());

    const challenge: ChallengeDefinition = {
        id: challengeId,
        name: process.env.CHALLENGE_NAME || listConfig?.name || "New Challenge",
        region: process.env.CHALLENGE_REGION || listConfig?.region || "Unknown",
        description:
            process.env.CHALLENGE_DESCRIPTION ||
            listConfig?.description ||
            "",
        centerLat,
        centerLng,
    };

    // Generate import result with statistics
    const result = generateImportResult(challenge, matches);

    // Print match report
    printMatchReport(result);

    // Export for review
    const exportFile = `review-${listId || "custom"}.json`;
    await exportMatchResults(result, exportFile);
    console.log(`\nTo review and edit matches, modify: ${exportFile}`);
    console.log(`Then run: REVIEW_FILE=${exportFile} npm run dev:once`);

    // Insert if not dry run
    await insertChallenge(result, {
        dryRun,
        includeConfidence: includeLowConfidence
            ? ["high", "medium", "low"]
            : ["high", "medium"],
        updatePeakCoords,
        createMissingPeaks,
    });

    if (dryRun) {
        console.log(`\nTo insert for real, run:`);
        console.log(`DRY_RUN=false ${listId ? `PEAKBAGGER_LIST_ID=${listId}` : `PEAKS_JSON_FILE=${peaksJsonFile}`} npm run dev:once`);
    }
};

export default importChallenge;

