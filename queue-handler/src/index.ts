import { config } from "dotenv";
config();
import processMessages from "../helpers/retrieveMessage";
import Fastify from "fastify";

const fastify = Fastify({ logger: true });

fastify.post("/", (request, reply) => {
    processMessages();
    reply.code(200).send("Processing messages");
});

fastify.listen({ port: 8080, host: "0.0.0.0" }, function (err, address) {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    fastify.log.info(`server listening on ${address}`);
});
