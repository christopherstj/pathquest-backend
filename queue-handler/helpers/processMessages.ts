import checkRateLimit from "./checkRateLimit";
import getCloudSqlConnection from "./getCloudSqlConnection";
import getMostRecentMessage from "./getMostRecentMessage";
import getNumberOfMessages from "./getNumberOfMessages";
import resetShortTermUsage from "./resetShortTermUsage";
import retrieveMessage from "./retrieveMessage";

const processMessages = async () => {
    console.log("processing messages");

    const connection = await getCloudSqlConnection();

    await resetShortTermUsage(connection);

    const allowedProcessing = await checkRateLimit(connection, false);

    console.log(`Allowed processing: ${allowedProcessing}`);

    const numberOfMessages = await getNumberOfMessages(connection);

    const messagesToProcess = Math.min(allowedProcessing, numberOfMessages);

    if (messagesToProcess === 0) {
        console.log("No messages to process");
        return;
    } else {
        console.log(`Processing ${messagesToProcess} messages`);

        for (let i = 0; i < messagesToProcess; i++) {
            await getMostRecentMessage(connection, async (message) => {
                const success = await retrieveMessage(connection, message);
            });
        }

        console.log("No more messages to process");
    }
};

export default processMessages;
