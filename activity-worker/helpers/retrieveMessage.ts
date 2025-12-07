import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import completeMessage from "./completeMessage";
import processDeleteMessage from "./processDeleteMessage";
import processCreateMessage from "./processMessage";
import processUpdateMessage from "./processUpdateMessage";
import setMessageStarted from "./setMessageStarted";

type ProcessResult = { success: boolean; error?: string };

const parseStravaEvent = (
    message: QueueMessage
): { event?: StravaEvent; error?: string } => {
    if (!message.json_data) {
        return { error: "Missing json_data in message" };
    }

    try {
        const event: StravaEvent =
            typeof message.json_data === "string"
                ? JSON.parse(message.json_data)
                : message.json_data;

        if (!event?.object_id || !event?.owner_id) {
            return { error: "Event missing required fields" };
        }

        return { event };
    } catch (err) {
        return {
            error: `Failed to parse json_data: ${(err as Error).message}`,
        };
    }
};

const logContext = (message: QueueMessage) => ({
    id: message.id,
    action: message.action,
});

const retrieveMessage = async (message: QueueMessage) => {
    const { event, error } = parseStravaEvent(message);
    if (error || !event) {
        console.error(logContext(message), error);
        if (message.id) {
            await completeMessage(message.id, error);
        }
        return false;
    }

    if (message.id) {
        await setMessageStarted(message.id);
    }

    let result: ProcessResult;
    try {
        switch (message.action) {
            case "create":
                result = await processCreateMessage(message, event);
                break;
            case "update":
                result = await processUpdateMessage(message, event);
                break;
            case "delete":
                result = await processDeleteMessage(message, event, true);
                break;
            default:
                result = { success: false, error: "Invalid action" };
        }
    } catch (err) {
        result = {
            success: false,
            error: `Unexpected error: ${(err as Error).message}`,
        };
    }

    if (result.success) {
        console.log(logContext(message), "message processed successfully");
    } else {
        console.error(
            { ...logContext(message), objectId: event.object_id },
            result.error
        );
    }

    if (message.id) {
        await completeMessage(message.id, result.error);
    }

    return result.success;
};

export default retrieveMessage;
