import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import completeMessage from "./completeMessage";
import processDeleteMessage from "./processDeleteMessage";
import processCreateMessage from "./processMessage";
import processUpdateMessage from "./processUpdateMessage";
import setMessageStarted from "./setMessageStarted";

const retrieveMessage = async (message: QueueMessage) => {
    if (message.id) await setMessageStarted(message.id);

    console.log("Processing message", message);

    const result = await (async (message: QueueMessage) => {
        switch (message.action) {
            case "create":
                const createResult = await processCreateMessage(message);
                return createResult;
            case "update":
                const updateResult = await processUpdateMessage(message);
                return updateResult;
            case "delete":
                const deleteResult = await processDeleteMessage(message, true);
                return deleteResult;
            default:
                return { success: false, error: "Invalid action" };
        }
    })(message);

    if (result.success) {
        console.log("Message processed successfully");
    } else {
        const messageData: StravaEvent =
            typeof message.json_data === "string"
                ? JSON.parse(message.json_data)
                : message.json_data;

        console.error(
            "Error processing message for activity" + messageData.object_id,
            result.error
        );
    }

    if (message.id) await completeMessage(message.id, result.error);

    return true;
};

export default retrieveMessage;
