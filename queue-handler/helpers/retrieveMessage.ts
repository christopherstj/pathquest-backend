import QueueMessage from "../typeDefs/QueueMessage";
import completeMessage from "./completeMessage";
import getMostRecentMessage from "./getMostRecentMessage";
import processMessage from "./processMessage";
import { Connection } from "mysql2/promise";

const retrieveMessage = async (
    connection: Connection,
    message: QueueMessage
) => {
    console.log("Processing message", message.id);

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
