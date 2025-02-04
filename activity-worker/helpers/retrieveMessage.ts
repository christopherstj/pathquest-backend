import { Pool } from "mysql2/promise";
import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import completeMessage from "./completeMessage";
import getCloudSqlConnection from "./getCloudSqlConnection";
import processDeleteMessage from "./processDeleteMessage";
import processCreateMessage from "./processMessage";
import processUpdateMessage from "./processUpdateMessage";
import setMessageStarted from "./setMessageStarted";

const retrieveMessage = async (message: QueueMessage) => {
    const pool = await getCloudSqlConnection();

    if (message.id) await setMessageStarted(pool, message.id);

    console.log("Processing message", message);

    const result = await (async (pool: Pool, message: QueueMessage) => {
        switch (message.action) {
            case "create":
                const createResult = await processCreateMessage(pool, message);
                return createResult;
            case "update":
                const updateResult = await processUpdateMessage(pool, message);
                return updateResult;
            case "delete":
                const deleteResult = await processDeleteMessage(
                    pool,
                    message,
                    true
                );
                return deleteResult;
            default:
                return { success: false, error: "Invalid action" };
        }
    })(pool, message);

    if (result.success) {
        console.log("Message processed successfully");
    } else {
        const messageData: StravaEvent =
            typeof message.jsonData === "string"
                ? JSON.parse(message.jsonData)
                : message.jsonData;

        console.error(
            "Error processing message for activity" + messageData.object_id,
            result.error
        );
    }

    if (message.id) await completeMessage(pool, message.id, result.error);

    return true;
};

export default retrieveMessage;
