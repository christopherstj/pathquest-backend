import completeMessage from "./completeMessage";
import getMostRecentMessage from "./getMostRecentMessage";
import processMessage from "./processMessage";

const retrieveMessage = async () => {
    const message = await getMostRecentMessage();

    if (!message) {
        console.log("No messages to process");
        return;
    }

    console.log("Processing message", message.id);

    const result = await processMessage(message);

    if (result.success) {
        console.log("Message processed successfully");
    } else {
        console.error("Error processing message", result.error);
    }

    await completeMessage(message.id, result.error);
};

export default retrieveMessage;
