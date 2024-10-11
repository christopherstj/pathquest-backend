import { config } from "dotenv";
config();
import Fastify from "fastify";

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

    console.log(data);

    reply.code(200).send();
});

fastify.listen({ port: 8080, host: "0.0.0.0" }, function (err, address) {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    fastify.log.info(`server listening on ${address}`);
});