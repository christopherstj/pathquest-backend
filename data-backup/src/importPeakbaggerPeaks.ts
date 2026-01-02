import { config } from "dotenv";
config();

import { PEAKBAGGER_LISTS, PeakbaggerListConfig } from "../typeDefs/ChallengeImport";
import scrapePeakbaggerList, {
    loadPeaksFromJson,
    savePeaksToJson,
} from "./scrapePeakbaggerList";
import getCloudSqlConnection from "./getCloudSqlConnection";
import { matchPeakbaggerPeaksOneToOne, writePeakbaggerMatchOutputs } from "./matchPeakbaggerPeaksOneToOne";
import ingestPeakbaggerPeaks from "./ingestPeakbaggerPeaks";

const importPeakbaggerPeaks = async (): Promise<void> => {
    const listId = process.env.PEAKBAGGER_LIST_ID ?? PEAKBAGGER_LISTS.CO_13ERS.listId;
    const peaksJsonFile = process.env.PEAKS_JSON_FILE;
    const outDir = process.env.PEAKBAGGER_OUT_DIR ?? ".";
    const rankedOnly = process.env.RANKED_ONLY === "true"; // default false (we want ranked+unranked)
    const dryRun = process.env.DRY_RUN !== "false"; // default true

    console.log("\n" + "═".repeat(80));
    console.log("PATHQUEST PEAKBAGGER PEAK INGEST (seed list + 1:1 matching)");
    console.log("═".repeat(80));
    console.log(`List ID: ${listId}`);
    console.log(`Ranked-only: ${rankedOnly ? "YES" : "NO"}`);
    console.log(`Dry run: ${dryRun ? "YES" : "NO"}`);

    let listConfig: PeakbaggerListConfig | null =
        Object.values(PEAKBAGGER_LISTS).find((c) => c.listId === listId) || null;
    if (!listConfig) {
        listConfig = {
            listId,
            name: `Peakbagger List ${listId}`,
            region: process.env.LIST_REGION ?? "Unknown",
            description: process.env.LIST_DESCRIPTION ?? "",
        };
    }

    let peaks;
    if (peaksJsonFile) {
        console.log(`\nMode: Load peaks from JSON`);
        console.log(`File: ${peaksJsonFile}`);
        peaks = await loadPeaksFromJson(peaksJsonFile);
    } else {
        console.log(`\nMode: Scrape from Peakbagger`);
        console.log(`List: ${listConfig.name}`);
        peaks = await scrapePeakbaggerList(listConfig, { rankedOnly });
        const cacheFile = `peaks-${listId}.json`;
        await savePeaksToJson(peaks, cacheFile);
        console.log(`Cached peak data to: ${cacheFile}`);
    }

    if (!peaks || peaks.length === 0) {
        throw new Error("No Peakbagger peaks found");
    }

    const pool = await getCloudSqlConnection();

    const matchResult = await matchPeakbaggerPeaksOneToOne(pool, peaks, {
        maxCandidates: Number.parseInt(process.env.PB_MATCH_MAX_CANDIDATES ?? "25", 10),
        matchRadiusMeters: Number.parseInt(process.env.PB_MATCH_RADIUS_METERS ?? "2000", 10),
        minScoreToConsider: Number.parseFloat(process.env.PB_MIN_SCORE ?? "0.35"),
        autoAcceptMinScore: Number.parseFloat(process.env.PB_AUTO_ACCEPT_MIN_SCORE ?? "0.75"),
        autoAcceptMaxDistanceMeters: Number.parseInt(process.env.PB_AUTO_ACCEPT_MAX_DISTANCE_METERS ?? "150", 10),
        autoAcceptMinNameSimilarity: Number.parseFloat(process.env.PB_AUTO_ACCEPT_MIN_NAME_SIMILARITY ?? "0.7"),
        minMarginForAutoAccept: Number.parseFloat(process.env.PB_MIN_MARGIN_FOR_AUTO_ACCEPT ?? "0.12"),
    });

    const outputFiles = await writePeakbaggerMatchOutputs(matchResult, {
        outDir,
        listId,
    });

    console.log("\nOutputs:");
    console.log(`  matched-high:  ${outputFiles.matchedHigh}`);
    console.log(`  matched-review:${outputFiles.matchedReview}`);
    console.log(`  unmatched:     ${outputFiles.unmatched}`);
    console.log(`  skipped (already linked): ${outputFiles.skippedAlreadyLinked}`);

    if (dryRun) {
        console.log(`\nDry-run complete.`);
        console.log(`To apply matched-high + insert unmatched, re-run with:`);
        console.log(`DRY_RUN=false PEAKBAGGER_LIST_ID=${listId} PEAKBAGGER_OUT_DIR=${outDir} npm run dev:once`);
        return;
    }

    await ingestPeakbaggerPeaks(pool, matchResult, {
        setSeedCoordsFromPeakbagger: process.env.SET_SEED_FROM_PEAKBAGGER === "true",
        setElevationFromPeakbagger: process.env.SET_ELEVATION_FROM_PEAKBAGGER !== "false",
    });
};

export default importPeakbaggerPeaks;


