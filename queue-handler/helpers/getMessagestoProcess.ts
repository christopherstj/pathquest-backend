import checkRateLimit from "./checkRateLimit";
import getNumberOfMessages from "./getNumberOfMessages";
import getMostRecentMessage from "./getMostRecentMessage";
import QueueMessage from "../typeDefs/QueueMessage";

const getMessagesToProcess = async () => {
    const allowedProcessing = await checkRateLimit(false);

    console.log(`Allowed processing: ${allowedProcessing}`);

    const numberOfMessages = await getNumberOfMessages();

    const messagesToProcess = Math.min(30, allowedProcessing, numberOfMessages);

    if (messagesToProcess > 100) {
        throw new Error("Too many messages to process");
    }

    if (messagesToProcess === 0) {
        console.log("No messages to process");
        return [];
    } else {
        const messages: QueueMessage[] = [];
        await getMostRecentMessage(messagesToProcess, (messageList) => {
            messages.push(...messageList);
        });

        return messages;
    }
};

export default getMessagesToProcess;
