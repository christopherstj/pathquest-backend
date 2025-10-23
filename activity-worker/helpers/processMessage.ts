import dayjs from "dayjs";
import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import getStravaActivity from "./getStravaActivity";
import updateStravaDescription from "./updateStravaDescription";
import getShouldUpdateDescription from "./getShouldUpdateDescription";

const processMessage = async (message: QueueMessage) => {
    try {
        if (!message.json_data)
            return { success: false, error: "No JSON data" };

        const messageData: StravaEvent =
            typeof message.json_data === "string"
                ? JSON.parse(message.json_data)
                : message.json_data;

        const description = await getStravaActivity(
            messageData.object_id,
            messageData.owner_id.toString()
        );

        const isWebhook = message.is_webhook;

        const updateDescription = await getShouldUpdateDescription(
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
            error: `Error processing ${message.id}: ${(err as Error).message}`,
        };
    }
};

export default processMessage;
