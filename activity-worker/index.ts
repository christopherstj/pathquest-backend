import { config } from "dotenv";
config();
import Fastify from "fastify";
import { Agent, setGlobalDispatcher } from "undici";
import retrieveMessage from "./helpers/retrieveMessage";
import QueueMessage from "./typeDefs/QueueMessage";
import StravaEvent from "./typeDefs/StravaEvent";

setGlobalDispatcher(
    new Agent({
        connect: { timeout: 60_000 },
    })
);

type PubSubBody = {
    message?: {
        data?: string;
    };
};

const fastify = Fastify({ logger: true });

const parsePubSubMessage = (body: PubSubBody) => {
    if (!body?.message) {
        return { error: "Invalid Pub/Sub message format" };
    }

    if (!body.message.data) {
        return { error: "No Pub/Sub data provided" };
    }

    try {
        const decoded = Buffer.from(body.message.data, "base64").toString().trim();
        const message: QueueMessage = JSON.parse(decoded);

        if (!message.action || !message.json_data) {
            return { error: "Missing required message fields" };
        }

        return { message };
    } catch (err) {
        return { error: `Failed to decode Pub/Sub data: ${(err as Error).message}` };
    }
};

fastify.post<{
    Body: PubSubBody;
}>("/", async (request, reply) => {
    if (!request.body) {
        reply.code(400).send("Bad Request: no Pub/Sub message received");
        return;
    }

    const { message, error } = parsePubSubMessage(request.body);
    if (error || !message) {
        request.log.error({ error }, "pubsub message rejected");
        reply.code(400).send(`Bad Request: ${error}`);
        return;
    }

    const messageData: StravaEvent =
        typeof message.json_data === "string"
            ? JSON.parse(message.json_data)
            : message.json_data;

    request.log.info(
        {
            id: message.id,
            action: message.action,
            objectId: messageData?.object_id,
        },
        "pubsub message accepted"
    );

    try {
        await retrieveMessage(message);
    } catch (err) {
        request.log.error(
            { err, id: message.id, action: message.action },
            "failed to process message"
        );
    }

    reply.code(200).send();
});

fastify.listen({ port: 8080, host: "0.0.0.0" }, function (err, address) {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`server listening on ${address}`);
});
