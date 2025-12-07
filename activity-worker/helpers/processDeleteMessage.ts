import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import deleteActivity from "./deleteActivity";

const processDeleteMessage = async (
    message: QueueMessage,
    event: StravaEvent,
    deleteManualPeaks: boolean
) => {
    try {
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
