import QueueMessage from "../typeDefs/QueueMessage";
import getCloudSqlConnection from "./getCloudSqlConnection";

const addEventToQueue = async (message: QueueMessage) => {
    const connection = await getCloudSqlConnection();

    await connection.execute(
        `INSERT INTO EventQueue (\`action\`, created, jsonData, isWebhook, userId, priority) VALUES (?, ?, ?, ?, ?, ?)`,
        [
            message.action,
            message.created,
            message.jsonData,
            message.isWebhook,
            message.userId,
            message.priority,
        ]
    );
};

export default addEventToQueue;
