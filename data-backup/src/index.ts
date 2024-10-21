import { config } from "dotenv";
config();
import fs from "fs";
import mysql from "mysql2/promise";
import OSMPeak from "../typeDefs/OSMPeak";
import Peak from "../typeDefs/Peak";
import geocodePeaks from "./geocodePeaks";

const main = async () => {
    await geocodePeaks();
};

main().catch((error) => {
    console.error(error);
});
