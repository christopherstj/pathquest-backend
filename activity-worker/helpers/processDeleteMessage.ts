import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import deleteActivity from "./deleteActivity";

const processDeleteMessage = async (
    message: QueueMessage,
    deleteManualPeaks: boolean
) => {
    try {
        const event = (
            typeof message.json_data === "string"
                ? JSON.parse(message.json_data)
                : message.json_data
        ) as StravaEvent;

        const id = event.object_id;

        await deleteActivity(id.toString(), deleteManualPeaks);

        return { success: true };
    } catch (err) {
        console.error(err);
        return {
            success: false,
            error: `Error processing ${message.id}: ${(err as Error).message}`,
        };
    }
};

export default processDeleteMessage;
