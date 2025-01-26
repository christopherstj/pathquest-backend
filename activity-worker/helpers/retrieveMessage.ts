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

    await setMessageStarted(pool, message.id);

    const result = await (async (pool: Pool, message: QueueMessage) => {
        switch (message.action) {
            case "create":
                const result1 = await processCreateMessage(pool, message);
                return result1;
            case "update":
                const result2 = await processUpdateMessage(pool, message);
                return result2;
            case "delete":
                const result3 = await processDeleteMessage(pool, message);
                return result3;
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

    await completeMessage(pool, message.id, result.error);

    return true;
};

export default retrieveMessage;
