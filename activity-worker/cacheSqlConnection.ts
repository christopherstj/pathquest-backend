import { config } from "dotenv";
config();
import getCloudSqlConnection from "./helpers/getCloudSqlConnection";

const main = async () => {
    await getCloudSqlConnection();
};

main()
    .then(() => {
        console.log("Finished");
        process.exit(0);
    })
    .catch((error) => {
        console.error(`Received error: ${(error as Error).message}`);
        process.exit(1);
    });
