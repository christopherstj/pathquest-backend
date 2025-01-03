import dayjs from "dayjs";
import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import getStravaActivity from "./getStravaActivity";
import updateStravaDescription from "./updateStravaDescription";
import { Connection, Pool } from "mysql2/promise";
import getShouldUpdateDescription from "./getShouldUpdateDescription";

const processMessage = async (pool: Pool, message: QueueMessage) => {
    console.log(`Processing message ${message.id}`);

    try {
        if (!message.jsonData) return { success: false, error: "No JSON data" };

        const messageData: StravaEvent =
            typeof message.jsonData === "string"
                ? JSON.parse(message.jsonData)
                : message.jsonData;

        const description = await getStravaActivity(
            pool,
            messageData.object_id,
            messageData.owner_id.toString()
        );

        const isWebhook = message.isWebhook;

        const updateDescription = await getShouldUpdateDescription(
            pool,
            messageData.owner_id.toString()
        );

        if (
            isWebhook &&
            description &&
            description.length > 0 &&
            updateDescription
        ) {
            console.log("Updating activity description");

            const success = await updateStravaDescription(
                pool,
                messageData.owner_id.toString(),
                messageData.object_id,
                description
            );

            console.log(success);
        }

        return { success: true };
    } catch (err) {
        console.error(err);
        return {
            success: false,
            error: `Error processing ${message.id}, check container logs`,
        };
    }
};

export default processMessage;
