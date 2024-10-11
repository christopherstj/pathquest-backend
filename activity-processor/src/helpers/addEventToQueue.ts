import QueueMessage from "../typeDefs/QueueMessage";
import getCloudSqlConnection from "./getCloudSqlConnection";

const addEventToQueue = async (message: QueueMessage) => {
    const connection = await getCloudSqlConnection();

    await connection.execute(
        `INSERT INTO EventQueue (\`action\`, created, jsonData, isWebhook) VALUES (?, ?, ?, ?)`,
        [message.action, message.created, message.jsonData, message.isWebhook]
    );
};

export default addEventToQueue;
