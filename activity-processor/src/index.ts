import { config } from "dotenv";
config();
import Fastify from "fastify";
import StravaEvent from "./typeDefs/StravaEvent";

const fastify = Fastify({ logger: true });

fastify.post<{
    Body: StravaEvent;
}>("/webhook", async (request, reply) => {
    request.log.info("Received webhook request");
    request.log.info(request.body);
    request.log.info(request.query);
    reply.send({ received: true });
});

fastify.get<{
    Querystring: {
        "hub.mode": string;
        "hub.verify_token": string;
        "hub.challenge": string;
    };
}>("/webhook", async (request, reply) => {
    const VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN ?? "";
    // Parses the query params
    const mode = request.query["hub.mode"];
    const token = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];
    // Checks if a token and mode is in the query string of the request
    if (mode && token) {
        // Verifies that the mode and token sent are valid
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            // Responds with the challenge token from the request
            console.log("WEBHOOK_VERIFIED");
            reply.send({ "hub.challenge": challenge });
        } else {
            // Responds with '403 Forbidden' if verify tokens do not match
            reply.code(403).send();
        }
    }
});

fastify.listen({ port: 8080, host: "0.0.0.0" }, function (err, address) {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    fastify.log.info(`server listening on ${address}`);
});
