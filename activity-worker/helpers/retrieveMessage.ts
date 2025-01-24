import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import completeMessage from "./completeMessage";
import getCloudSqlConnection from "./getCloudSqlConnection";
import processDeleteMessage from "./processDeleteMessage";
import processCreateMessage from "./processMessage";
import setMessageStarted from "./setMessageStarted";

const retrieveMessage = async (message: QueueMessage) => {
    const pool = await getCloudSqlConnection();

    await setMessageStarted(pool, message.id);

    switch (message.action) {
        case "create":
            await processCreateMessage(pool, message);
            break;
        case "update":
            console.log("Update message received but not implemented");
            break;
        case "delete":
            await processDeleteMessage(pool, message);
            break;
    }

    const result = await processCreateMessage(pool, message);

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
