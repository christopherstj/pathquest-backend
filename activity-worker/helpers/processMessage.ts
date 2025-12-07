import dayjs from "dayjs";
import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import getStravaActivity from "./getStravaActivity";
import updateStravaDescription from "./updateStravaDescription";
import getShouldUpdateDescription from "./getShouldUpdateDescription";

const processMessage = async (
    message: QueueMessage,
    event: StravaEvent
) => {
    try {
        const description = await getStravaActivity(
            event.object_id,
            event.owner_id.toString()
        );

        const isWebhook = message.is_webhook;

        const updateDescription = await getShouldUpdateDescription(
            event.owner_id.toString()
        );

        if (
            isWebhook &&
            description &&
            description.length > 0 &&
            updateDescription
        ) {
            console.log("Updating activity description");

            const success = await updateStravaDescription(
                event.owner_id.toString(),
                event.object_id,
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
