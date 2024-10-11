import { config } from "dotenv";
config();
import Fastify from "fastify";
import resetRateLimit from "./helpers/resetRateLimit";

const fastify = Fastify({ logger: true });

fastify.post("/", async (request, reply) => {
    await resetRateLimit();
    reply.code(200).send("Rate limit reset");
});

fastify.listen({ port: 8080, host: "0.0.0.0" }, function (err, address) {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    fastify.log.info(`server listening on ${address}`);
});
