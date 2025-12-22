import { config } from "dotenv";
config();
import geocodePeaks from "./geocodePeaks";
import getPeakElevations from "./getPeakElevations";
import getOsmData from "./getOsmData";
import loadOsmData from "./loadOsmData";
import mysqlToPsql from "./mysqlToPsql";
import importChallenge from "./importChallenge";
import test from "./test";

const main = async () => {
    // === DATA IMPORT TOOLS ===
    // await getPeakElevations();
    // await geocodePeaks();
    // await getOsmData();
    // await loadOsmData();
    // await mysqlToPsql();
    // await test();

    // === CHALLENGE IMPORT PIPELINE ===
    // Use environment variables to control behavior:
    //   PEAKBAGGER_LIST_ID=5061    - Scrape from Peakbagger list
    //   PEAKS_JSON_FILE=peaks.json - Load peaks from JSON file
    //   REVIEW_FILE=review.json    - Import reviewed matches
    //   DRY_RUN=false              - Actually insert (default: true)
    //   INCLUDE_LOW_CONFIDENCE=true - Include low confidence matches
    //
    // Example usage:
    //   PEAKBAGGER_LIST_ID=5061 npm run dev:once
    //   DRY_RUN=false REVIEW_FILE=review-5061.json npm run dev:once
    await importChallenge();
};

main().catch((error) => {
    console.error(error);
});
