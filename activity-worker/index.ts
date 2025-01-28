import { config } from "dotenv";
config();
import Fastify from "fastify";
import retrieveMessage from "./helpers/retrieveMessage";
import QueueMessage from "./typeDefs/QueueMessage";
import { Agent, setGlobalDispatcher } from "undici";
import getStravaActivity from "./helpers/getStravaActivity";
import getCloudSqlConnection from "./helpers/getCloudSqlConnection";
import StravaEvent from "./typeDefs/StravaEvent";

setGlobalDispatcher(
    new Agent({
        connect: { timeout: 60_000 },
    })
);

const fastify = Fastify({ logger: true });

fastify.post<{
    Body: {
        message: {
            data: any;
        };
    };
}>("/", (request, reply) => {
    if (!request.body) {
        const msg = "no Pub/Sub message received";
        console.error(`error: ${msg}`);
        reply.code(400).send(`Bad Request: ${msg}`);
        return;
    }
    if (!request.body.message) {
        const msg = "invalid Pub/Sub message format";
        console.error(`error: ${msg}`);
        reply.code(400).send(`Bad Request: ${msg}`);
        return;
    }

    const pubSubMessage = request.body.message;

    const data = pubSubMessage.data
        ? Buffer.from(pubSubMessage.data, "base64").toString().trim()
        : "World";

    const message: QueueMessage = JSON.parse(data);

    const messageData: StravaEvent = JSON.parse(message.jsonData);

    console.log(
        message.id
            ? `Processing ${message.id}`
            : `Processing message for activity ${messageData.object_id}`
    );

    retrieveMessage(message);

    reply.code(200).send();
});

fastify.post<{
    Body: {
        ownerId: string;
        objectId: number;
    };
}>("/test", async (request, reply) => {
    const { ownerId, objectId } = request.body;

    const connection = await getCloudSqlConnection();

    const description = await getStravaActivity(
        connection,
        objectId,
        ownerId.toString()
    );

    console.log(description);

    reply.code(200).send();
});

fastify.listen({ port: 8080, host: "0.0.0.0" }, function (err, address) {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`server listening on ${address}`);
});
