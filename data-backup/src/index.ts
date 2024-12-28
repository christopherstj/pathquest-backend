import { config } from "dotenv";
config();
import geocodePeaks from "./geocodePeaks";

const main = async () => {
    await geocodePeaks();
};

main().catch((error) => {
    console.error(error);
});
