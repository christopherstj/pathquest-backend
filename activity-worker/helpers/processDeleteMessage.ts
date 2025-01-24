import { Pool } from "mysql2/promise";
import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";

const processDeleteMessage = async (pool: Pool, message: QueueMessage) => {
    const event = JSON.parse(message.jsonData) as StravaEvent;

    const id = event.object_id;

    await pool.execute(`DELETE FROM Activity WHERE id = ?`, [id]);
};

export default processDeleteMessage;
