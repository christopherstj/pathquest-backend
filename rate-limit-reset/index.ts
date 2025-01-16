import { config } from "dotenv";
config();
import Fastify from "fastify";
import resetRateLimit from "./helpers/resetRateLimit";
import resetShortTermUsage from "./helpers/resetShortTermUsage";
import getCloudSqlConnection from "./helpers/getCloudSqlConnection";

const fastify = Fastify({ logger: true });

fastify.post("/", async (request, reply) => {
    const pool = await getCloudSqlConnection();
    await resetRateLimit(pool);
    reply.code(200).send("Long-term rate limit reset");
});

fastify.post("/short-term", async (request, reply) => {
    const pool = await getCloudSqlConnection();
    await resetShortTermUsage(pool);
    reply.code(200).send("Short-term rate limit reset");
});

fastify.listen({ port: 8080, host: "0.0.0.0" }, function (err, address) {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    fastify.log.info(`server listening on ${address}`);
});
