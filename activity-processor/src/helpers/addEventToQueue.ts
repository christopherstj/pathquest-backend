import QueueMessage from "../typeDefs/QueueMessage";
import getCloudSqlConnection from "./getCloudSqlConnection";

const addEventToQueue = async (message: QueueMessage) => {
    const pool = await getCloudSqlConnection();

    await pool.query(
        `INSERT INTO event_queue (action, created, json_data, is_webhook, user_id, priority) VALUES ($1, $2, $3, $4, $5, $6)`,
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
