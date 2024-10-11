import { config } from "dotenv";
config();
import processMessages from "./helpers/processMessages";
import Fastify from "fastify";
import { PubSub } from "@google-cloud/pubsub";
import getCloudSqlConnection from "./helpers/getCloudSqlConnection";
import getMostRecentMessage from "./helpers/getMostRecentMessage";
import getMessagesToProcess from "./helpers/getMessagestoProcess";
import completeMessage from "./helpers/completeMessage";

const topicName = process.env.PUBSUB_TOPIC ?? "";

const pubSubClient = new PubSub();

const fastify = Fastify({ logger: true });

fastify.post("/", async (request, reply) => {
    // processMessages();
    reply.code(200).send("Processing messages");
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
});

fastify.listen({ port: 8080, host: "0.0.0.0" }, function (err, address) {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    fastify.log.info(`server listening on ${address}`);
});
