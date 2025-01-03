import { Connection, Pool } from "mysql2/promise";
import getCloudSqlConnection from "./getCloudSqlConnection";
import resetShortTermUsage from "./resetShortTermUsage";
import checkRateLimit from "./checkRateLimit";
import getNumberOfMessages from "./getNumberOfMessages";
import getMostRecentMessage from "./getMostRecentMessage";
import QueueMessage from "../typeDefs/QueueMessage";

const getMessagesToProcess = async (pool: Pool) => {
    await resetShortTermUsage(pool);

    const allowedProcessing = await checkRateLimit(pool, false);

    console.log(`Allowed processing: ${allowedProcessing}`);

    const numberOfMessages = await getNumberOfMessages(pool);

    const messagesToProcess = Math.min(allowedProcessing, numberOfMessages);

    if (messagesToProcess === 0) {
        console.log("No messages to process");
        return [];
    } else {
        const messages: QueueMessage[] = [];
        for (let i = 0; i < messagesToProcess; i++) {
            await getMostRecentMessage(pool, (message) => {
                messages.push(message);
            });
        }

        return messages;
    }
};

export default getMessagesToProcess;
