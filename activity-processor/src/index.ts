import { config } from "dotenv";
config();
import Fastify from "fastify";
import StravaEvent from "./typeDefs/StravaEvent";
import QueueMessage from "./typeDefs/QueueMessage";
import dayjs from "dayjs";
import addEventToQueue from "./helpers/addEventToQueue";

const fastify = Fastify({ logger: true });

fastify.post("/webhook", async (request, reply) => {
    const data: StravaEvent =
        typeof request.body === "string"
            ? JSON.parse(request.body)
            : request.body;

    if (data.aspect_type !== "create") {
        reply.code(200).send("Ignoring event");
        return;
    }

    console.log("Processing activity", data.object_id);

    const message: QueueMessage = {
        action: "create",
        created: dayjs().format("YYYY-MM-DD HH:mm:ss"),
        jsonData: JSON.stringify(data),
        isWebhook: true,
    };

    await addEventToQueue(message);

    reply.code(200).send("Event added to queue");
});

fastify.get<{
    Querystring: {
        "hub.mode": string;
        "hub.verify_token": string;
        "hub.challenge": string;
    };
}>("/webhook", async (request, reply) => {
    // One-time call to verify the webhook
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
