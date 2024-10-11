import { Connection } from "mysql2/promise";
import getCloudSqlConnection from "./getCloudSqlConnection";
import resetShortTermUsage from "./resetShortTermUsage";
import checkRateLimit from "./checkRateLimit";
import getNumberOfMessages from "./getNumberOfMessages";
import getMostRecentMessage from "./getMostRecentMessage";
import QueueMessage from "../typeDefs/QueueMessage";

const getMessagesToProcess = async (connection: Connection) => {
    await resetShortTermUsage(connection);

    const allowedProcessing = await checkRateLimit(connection, false);

    console.log(`Allowed processing: ${allowedProcessing}`);

    const numberOfMessages = await getNumberOfMessages(connection);

    const messagesToProcess = Math.min(allowedProcessing, numberOfMessages);

    if (messagesToProcess === 0) {
        console.log("No messages to process");
        return [];
    } else {
        const messages: QueueMessage[] = [];
        for (let i = 0; i < messagesToProcess; i++) {
            await getMostRecentMessage(connection, (message) => {
                messages.push(message);
            });
        }

        return messages;
    }
};

export default getMessagesToProcess;
