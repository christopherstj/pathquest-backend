import { config } from "dotenv";
config();
import geocodePeaks from "./geocodePeaks";
import getPeakElevations from "./getPeakElevations";
import getOsmData from "./getOsmData";
import loadOsmData from "./loadOsmData";

const main = async () => {
    // await getPeakElevations();
    // await geocodePeaks();
    await getOsmData();
    // await loadOsmData();
};

main().catch((error) => {
    console.error(error);
});
