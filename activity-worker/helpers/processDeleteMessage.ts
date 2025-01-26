import { Pool } from "mysql2/promise";
import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";

const processDeleteMessage = async (pool: Pool, message: QueueMessage) => {
    try {
        const event = (
            typeof message.jsonData === "string"
                ? JSON.parse(message.jsonData)
                : message.jsonData
        ) as StravaEvent;

        const id = event.object_id;

        await pool.execute(`DELETE FROM Activity WHERE id = ?`, [id]);

        return { success: true };
    } catch (err) {
        console.error(err);
        return {
            success: false,
            error: `Error processing ${message.id}: ${(err as Error).message}`,
        };
    }
};

export default processDeleteMessage;
