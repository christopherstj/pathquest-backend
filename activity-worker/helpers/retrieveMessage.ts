import QueueMessage from "../typeDefs/QueueMessage";
import completeMessage from "./completeMessage";
import getCloudSqlConnection from "./getCloudSqlConnection";
import processMessage from "./processMessage";
import setMessageStarted from "./setMessageStarted";

const retrieveMessage = async (message: QueueMessage) => {
    const connection = await getCloudSqlConnection();

    console.log("Processing message", message.id);

    await setMessageStarted(connection, message.id);

    const result = await processMessage(connection, message);

    if (result.success) {
        console.log("Message processed successfully");
    } else {
        console.error("Error processing message", result.error);
    }

    await completeMessage(connection, message.id, result.error);

    return true;
};

export default retrieveMessage;
