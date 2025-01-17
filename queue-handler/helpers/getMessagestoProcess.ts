import { Connection, Pool } from "mysql2/promise";
import getCloudSqlConnection from "./getCloudSqlConnection";
import resetShortTermUsage from "./resetShortTermUsage";
import checkRateLimit from "./checkRateLimit";
import getNumberOfMessages from "./getNumberOfMessages";
import getMostRecentMessage from "./getMostRecentMessage";
import QueueMessage from "../typeDefs/QueueMessage";

const getMessagesToProcess = async (pool: Pool) => {
    const allowedProcessing = await checkRateLimit(pool, false);

    console.log(`Allowed processing: ${allowedProcessing}`);

    const numberOfMessages = await getNumberOfMessages(pool);

    const messagesToProcess = Math.min(30, allowedProcessing, numberOfMessages);

    if (messagesToProcess > 100) {
        throw new Error("Too many messages to process");
    }

    if (messagesToProcess === 0) {
        console.log("No messages to process");
        return [];
    } else {
        const messages: QueueMessage[] = [];
        await getMostRecentMessage(pool, messagesToProcess, (messageList) => {
            messages.push(...messageList);
        });

        return messages;
    }
};

export default getMessagesToProcess;
