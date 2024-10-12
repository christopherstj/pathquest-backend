import async from "async";
import checkRateLimit from "./checkRateLimit";
import getCloudSqlConnection from "./getCloudSqlConnection";
import getMostRecentMessage from "./getMostRecentMessage";
import getNumberOfMessages from "./getNumberOfMessages";
import resetShortTermUsage from "./resetShortTermUsage";
import retrieveMessage from "./retrieveMessage";
import QueueMessage from "../typeDefs/QueueMessage";
import getMessagesToProcess from "./getMessagestoProcess";
import { PubSub } from "@google-cloud/pubsub";
import completeMessage from "./completeMessage";

const topicName = process.env.PUBSUB_TOPIC ?? "";

const pubSubClient = new PubSub();

const processMessages = async () => {
    const connection = await getCloudSqlConnection();

    const messages = await getMessagesToProcess(connection);

    messages.forEach(async (message) => {
        const data = JSON.stringify(message);
        const dataBuffer = Buffer.from(data);

        try {
            const messageId = await pubSubClient
                .topic(topicName)
                .publishMessage({ data: dataBuffer });
            console.log(`Message ${messageId} published.`);
        } catch (error) {
            console.error(
                `Received error while publishing: ${(error as Error).message}`
            );
            await completeMessage(
                connection,
                message.id,
                (error as Error).message
            );
            process.exitCode = 1;
        }
    });
    // console.log("processing messages");

    // const connection = await getCloudSqlConnection();

    // await resetShortTermUsage(connection);

    // const allowedProcessing = await checkRateLimit(connection, false);

    // console.log(`Allowed processing: ${allowedProcessing}`);

    // const numberOfMessages = await getNumberOfMessages(connection);

    // const messagesToProcess = Math.min(allowedProcessing, numberOfMessages);

    // if (messagesToProcess === 0) {
    //     console.log("No messages to process");
    //     return;
    // } else {
    //     console.log(`Processing ${messagesToProcess} messages`);

    //     const queue = async.queue(async (message: QueueMessage, callback) => {
    //         const success = await retrieveMessage(connection, message);
    //         callback();
    //     }, 20);

    //     for (let i = 0; i < messagesToProcess; i++) {
    //         await getMostRecentMessage(connection, (message) => {
    //             queue.push(message, () => {
    //                 console.log(`Message ${message.id} processed`);
    //             });
    //         });
    //     }

    //     await queue.drain();

    //     console.log("No more messages to process");
    // }
};

export default processMessages;
