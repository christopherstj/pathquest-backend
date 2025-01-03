import { config } from "dotenv";
config();
import geocodePeaks from "./geocodePeaks";
import getPeakElevations from "./getPeakElevations";

const main = async () => {
    // await getPeakElevations();
    await geocodePeaks();
};

main().catch((error) => {
    console.error(error);
});
