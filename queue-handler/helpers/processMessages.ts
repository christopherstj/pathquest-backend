import getCloudSqlConnection from "./getCloudSqlConnection";
import getMessagesToProcess from "./getMessagestoProcess";
import { PubSub } from "@google-cloud/pubsub";
import completeMessage from "./completeMessage";
// import grpc from "@grpc/grpc-js";

const topicName = process.env.PUBSUB_TOPIC ?? "";

const pubSubClient = new PubSub();

const processMessages = async () => {
    const pool = await getCloudSqlConnection();

    const messages = await getMessagesToProcess(pool);

    const publisher = pubSubClient.topic(topicName, {
        batching: {
            maxMessages: 10,
            maxMilliseconds: 60000,
        },
    });

    const promises: Promise<string>[] = [];

    messages.forEach(async (message) => {
        const data = JSON.stringify(message);
        const dataBuffer = Buffer.from(data);

        try {
            promises.push(publisher.publishMessage({ data: dataBuffer }));
        } catch (error) {
            console.error(
                `Received error while publishing: ${(error as Error).message}`
            );
            await completeMessage(pool, message.id, (error as Error).message);
            process.exitCode = 1;
        }
    });

    const messageIds = await Promise.all(promises);

    console.log(`Published ${messageIds.length} messages`);
};

export default processMessages;
