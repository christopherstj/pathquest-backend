import { config } from "dotenv";
config();

import getCloudSqlConnection from "./getCloudSqlConnection";
import { savePeaksToJson, loadPeaksFromJson } from "./scrapePeakbaggerList";
import scrape14ersListPage from "./scrape14ers";
import { matchExternalPeaksOneToOne, writeExternalMatchOutputs } from "./matchExternalPeaksOneToOne";
import ingestExternalPeaks from "./ingestExternalPeaks";
import * as fs from "fs";

const SOURCE = "14ers";

const loadJson = <T,>(filePath: string): T => {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
};

export default async function import14ersPeaks(): Promise<void> {
    const peaksJsonFile = process.env.PEAKS_JSON_FILE;
    const outDir = process.env.FOURTEENERS_OUT_DIR ?? ".";
    const dryRun = process.env.DRY_RUN !== "false"; // default true
    const reviewFile = process.env.REVIEW_FILE;
    const matchedHighFile = process.env.MATCHED_HIGH_FILE;
    const unmatchedFile = process.env.UNMATCHED_FILE;
    const setPrimaryFrom14ers = process.env.SET_PRIMARY_FROM_14ERS !== "false"; // default true

    const maxPeaks = process.env.FOURTEENERS_MAX_PEAKS
        ? Number.parseInt(process.env.FOURTEENERS_MAX_PEAKS, 10)
        : undefined;

    console.log("\n" + "═".repeat(80));
    console.log("PATHQUEST 14ERS.COM PEAK INGEST (scrape list -> get coords -> 1:1 matching)");
    console.log("═".repeat(80));
    console.log(`Dry run: ${dryRun ? "YES" : "NO"}`);

    const useExistingMatchFiles = Boolean(reviewFile || matchedHighFile || unmatchedFile);
    if (useExistingMatchFiles) {
        if (!matchedHighFile || !unmatchedFile || !reviewFile) {
            throw new Error(
                `When using existing match files you must provide REVIEW_FILE, MATCHED_HIGH_FILE, and UNMATCHED_FILE.`
            );
        }

        console.log(`\nMode: Ingest from existing match files`);
        console.log(`  matched-high: ${matchedHighFile}`);
        console.log(`  matched-review (edited): ${reviewFile}`);
        console.log(`  unmatched: ${unmatchedFile}`);

        const matchedHigh = loadJson<any[]>(matchedHighFile);
        const unmatched = loadJson<any[]>(unmatchedFile);

        console.log(`\nLoaded:`);
        console.log(`  matched-high: ${matchedHigh.length}`);
        console.log(`  unmatched:    ${unmatched.length}`);

        if (dryRun) {
            console.log(`\nDry-run complete (no DB changes).`);
            console.log(`Next: set DRY_RUN=false to apply.`)
            return;
        }

        const pool = await getCloudSqlConnection();
        await ingestExternalPeaks(pool, {
            matchedHigh: matchedHigh as any,
            matchedReview: [],
            unmatched: unmatched as any,
            skippedAlreadyLinked: [],
        }, {
            source: SOURCE,
            elevationSourceLabel: SOURCE,
            setSeedCoordsFromSource: process.env.SET_SEED_FROM_14ERS === "true",
            setPrimaryCoordsFromSource: setPrimaryFrom14ers,
            setElevationFromSource: process.env.SET_ELEVATION_FROM_14ERS !== "false",
            reviewFilePath: reviewFile,
            rejectedAction: process.env.REJECTED_ACTION === "insert" ? "insert" : "skip",
        });

        return;
    }

    let peaks;
    if (peaksJsonFile) {
        console.log(`\nMode: Load peaks from JSON`);
        console.log(`File: ${peaksJsonFile}`);
        peaks = await loadPeaksFromJson(peaksJsonFile);
    } else {
        console.log(`\nMode: Scrape 14ers.com`);
        peaks = await scrape14ersListPage({
            maxPeaks,
            sleepMs: Number.parseInt(process.env.FOURTEENERS_SLEEP_MS ?? "300", 10),
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
        maxCandidates: Number.parseInt(process.env.F14_MATCH_MAX_CANDIDATES ?? "25", 10),
        matchRadiusMeters: Number.parseInt(process.env.F14_MATCH_RADIUS_METERS ?? "2000", 10),
        minScoreToConsider: Number.parseFloat(process.env.F14_MIN_SCORE ?? "0.35"),
        autoAcceptMinScore: Number.parseFloat(process.env.F14_AUTO_ACCEPT_MIN_SCORE ?? "0.75"),
        autoAcceptMaxDistanceMeters: Number.parseInt(process.env.F14_AUTO_ACCEPT_MAX_DISTANCE_METERS ?? "150", 10),
        autoAcceptMinNameSimilarity: Number.parseFloat(process.env.F14_AUTO_ACCEPT_MIN_NAME_SIMILARITY ?? "0.7"),
        minMarginForAutoAccept: Number.parseFloat(process.env.F14_MIN_MARGIN_FOR_AUTO_ACCEPT ?? "0.12"),
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
        console.log(`DRY_RUN=false FOURTEENERS_OUT_DIR=${outDir} PEAKS_JSON_FILE=peaks-${SOURCE}.json npm run dev:once`);
        console.log(`\nOr to ingest from your edited review file without re-running matching (recommended):`);
        console.log(
            `DRY_RUN=false REVIEW_FILE=${outputFiles.matchedReview} MATCHED_HIGH_FILE=${outputFiles.matchedHigh} UNMATCHED_FILE=${outputFiles.unmatched} REJECTED_ACTION=insert TASK=import-14ers-peaks npm run dev:once`
        );
        return;
    }

    await ingestExternalPeaks(pool, matchResult, {
        source: SOURCE,
        elevationSourceLabel: SOURCE,
        setSeedCoordsFromSource: process.env.SET_SEED_FROM_14ERS === "true",
        setPrimaryCoordsFromSource: setPrimaryFrom14ers,
        setElevationFromSource: process.env.SET_ELEVATION_FROM_14ERS !== "false",
        reviewFilePath: outputFiles.matchedReview,
        rejectedAction: process.env.REJECTED_ACTION === "insert" ? "insert" : "skip",
    });
}

