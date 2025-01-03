import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import completeMessage from "./completeMessage";
import getCloudSqlConnection from "./getCloudSqlConnection";
import processMessage from "./processMessage";
import setMessageStarted from "./setMessageStarted";

const retrieveMessage = async (message: QueueMessage) => {
    const pool = await getCloudSqlConnection();

    console.log("Processing message", message.id);

    await setMessageStarted(pool, message.id);

    const result = await processMessage(pool, message);

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
