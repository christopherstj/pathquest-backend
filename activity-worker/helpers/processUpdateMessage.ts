import { Pool } from "mysql2/promise";
import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import updateActivityTitle from "./updateActivityTitle";
import updateActivityVisibility from "./updateActivityVisibility";

const processUpdateMessage = async (pool: Pool, message: QueueMessage) => {
    try {
        const event = (
            typeof message.jsonData === "string"
                ? JSON.parse(message.jsonData)
                : message.jsonData
        ) as StravaEvent;

        const id = event.object_id;

        if (!event.updates) {
            return {
                success: false,
                error: `No updates provided for ${message.id}`,
            };
        }

        if (
            "title" in event.updates &&
            typeof event.updates.title === "string"
        ) {
            await updateActivityTitle(pool, id, event.updates.title);
        }

        if ("type" in event.updates && typeof event.updates.type === "string") {
            await pool.execute(`UPDATE Activity SET sport = ? WHERE id = ?`, [
                event.updates.type,
                id,
            ]);
        }

        if ("private" in event.updates) {
            const isPublic =
                event.updates.private === false ||
                event.updates.private === "false";
            await updateActivityVisibility(pool, id, isPublic);
        }

        return { success: true };
    } catch (err) {
        console.error(err);
        return {
            success: false,
            error: `Error processing ${message.id}: ${(err as Error).message}`,
        };
    }
};

export default processUpdateMessage;
