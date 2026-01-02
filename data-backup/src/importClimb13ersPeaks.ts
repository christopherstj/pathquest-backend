import { config } from "dotenv";
config();

import getCloudSqlConnection from "./getCloudSqlConnection";
import { savePeaksToJson, loadPeaksFromJson } from "./scrapePeakbaggerList";
import scrapeClimb13ersFromListPage from "./scrapeClimb13ers";
import { matchExternalPeaksOneToOne, writeExternalMatchOutputs } from "./matchExternalPeaksOneToOne";
import ingestExternalPeaks from "./ingestExternalPeaks";

const SOURCE = "climb13ers";

export default async function importClimb13ersPeaks(): Promise<void> {
    const listUrl = process.env.CLIMB13ERS_LIST_URL;
    const peaksJsonFile = process.env.PEAKS_JSON_FILE;
    const outDir = process.env.CLIMB13ERS_OUT_DIR ?? ".";
    const dryRun = process.env.DRY_RUN !== "false"; // default true

    const maxPeaks = process.env.CLIMB13ERS_MAX_PEAKS
        ? Number.parseInt(process.env.CLIMB13ERS_MAX_PEAKS, 10)
        : undefined;

    console.log("\n" + "═".repeat(80));
    console.log("PATHQUEST CLIMB13ERS PEAK INGEST (crawl list -> coords -> 1:1 matching)");
    console.log("═".repeat(80));
    console.log(`Dry run: ${dryRun ? "YES" : "NO"}`);

    let peaks;
    if (peaksJsonFile) {
        console.log(`\nMode: Load peaks from JSON`);
        console.log(`File: ${peaksJsonFile}`);
        peaks = await loadPeaksFromJson(peaksJsonFile);
    } else {
        if (!listUrl) {
            throw new Error("CLIMB13ERS_LIST_URL is required unless PEAKS_JSON_FILE is provided.");
        }
        console.log(`\nMode: Scrape Climb13ers from list page`);
        peaks = await scrapeClimb13ersFromListPage(listUrl, {
            maxPeaks,
            sleepMs: Number.parseInt(process.env.CLIMB13ERS_SLEEP_MS ?? "500", 10),
        });
        const cacheFile = `peaks-${SOURCE}.json`;
        await savePeaksToJson(peaks, cacheFile);
        console.log(`Cached peak data to: ${cacheFile}`);
    }

    if (!peaks || peaks.length === 0) {
        throw new Error("No peaks found");
    }

    const pool = await getCloudSqlConnection();
    const matchResult = await matchExternalPeaksOneToOne(pool, SOURCE, peaks, {
        maxCandidates: Number.parseInt(process.env.C13_MATCH_MAX_CANDIDATES ?? "25", 10),
        matchRadiusMeters: Number.parseInt(process.env.C13_MATCH_RADIUS_METERS ?? "2000", 10),
        minScoreToConsider: Number.parseFloat(process.env.C13_MIN_SCORE ?? "0.35"),
        autoAcceptMinScore: Number.parseFloat(process.env.C13_AUTO_ACCEPT_MIN_SCORE ?? "0.75"),
        autoAcceptMaxDistanceMeters: Number.parseInt(process.env.C13_AUTO_ACCEPT_MAX_DISTANCE_METERS ?? "150", 10),
        autoAcceptMinNameSimilarity: Number.parseFloat(process.env.C13_AUTO_ACCEPT_MIN_NAME_SIMILARITY ?? "0.7"),
        minMarginForAutoAccept: Number.parseFloat(process.env.C13_MIN_MARGIN_FOR_AUTO_ACCEPT ?? "0.12"),
    });

    const outputFiles = await writeExternalMatchOutputs(matchResult, { outDir, source: SOURCE });
    console.log("\nOutputs:");
    console.log(`  matched-high:  ${outputFiles.matchedHigh}`);
    console.log(`  matched-review:${outputFiles.matchedReview}`);
    console.log(`  unmatched:     ${outputFiles.unmatched}`);
    console.log(`  skipped (already linked): ${outputFiles.skippedAlreadyLinked}`);

    if (dryRun) {
        console.log(`\nDry-run complete.`);
        console.log(`\nTo review matches, edit: ${outputFiles.matchedReview}`);
        console.log(`  Set "approved": true  to link the match`);
        console.log(`  Set "approved": false to skip (or insert as new if REJECTED_ACTION=insert)`);
        console.log(`  Leave "approved": null to skip for now`);
        console.log(`\nTo apply matched-high + approved reviews + insert unmatched, re-run with:`);
        console.log(`DRY_RUN=false CLIMB13ERS_OUT_DIR=${outDir} PEAKS_JSON_FILE=peaks-${SOURCE}.json npm run dev:once`);
        return;
    }

    await ingestExternalPeaks(pool, matchResult, {
        source: SOURCE,
        elevationSourceLabel: SOURCE,
        setSeedCoordsFromSource: process.env.SET_SEED_FROM_CLIMB13ERS === "true",
        setElevationFromSource: process.env.SET_ELEVATION_FROM_CLIMB13ERS !== "false",
        reviewFilePath: outputFiles.matchedReview,
        rejectedAction: process.env.REJECTED_ACTION === "insert" ? "insert" : "skip",
    });
}


