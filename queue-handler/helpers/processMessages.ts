import getCloudSqlConnection from "./getCloudSqlConnection";
import getMessagesToProcess from "./getMessagestoProcess";
import { PubSub } from "@google-cloud/pubsub";
import completeMessage from "./completeMessage";

const topicName = process.env.PUBSUB_TOPIC ?? "";

const pubSubClient = new PubSub();

const processMessages = async () => {
    const pool = await getCloudSqlConnection();

    const messages = await getMessagesToProcess(pool);

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
            await completeMessage(pool, message.id, (error as Error).message);
            process.exitCode = 1;
        }
    });
};

export default processMessages;
