import { config } from "dotenv";
config();
import geocodePeaks from "./geocodePeaks";
import getPeakElevations from "./getPeakElevations";
import getOsmData from "./getOsmData";
import loadOsmData from "./loadOsmData";
import mysqlToPsql from "./mysqlToPsql";
import test from "./test";

const main = async () => {
    // await getPeakElevations();
    // await geocodePeaks();
    // await getOsmData();
    // await loadOsmData();
    // await mysqlToPsql();
    await test();
};

main().catch((error) => {
    console.error(error);
});
