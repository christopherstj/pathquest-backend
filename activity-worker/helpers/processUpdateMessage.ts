import QueueMessage from "../typeDefs/QueueMessage";
import StravaEvent from "../typeDefs/StravaEvent";
import getCloudSqlConnection from "./getCloudSqlConnection";
import updateActivityTitle from "./updateActivityTitle";
import updateActivityVisibility from "./updateActivityVisibility";

const processUpdateMessage = async (
    message: QueueMessage,
    event: StravaEvent
) => {
    const pool = await getCloudSqlConnection();

    try {
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
            await updateActivityTitle(id, event.updates.title);
        }

        if ("type" in event.updates && typeof event.updates.type === "string") {
            await pool.query(`UPDATE activities SET sport = $1 WHERE id = $2`, [
                event.updates.type,
                id,
            ]);
        }

        if ("private" in event.updates) {
            const isPublic =
                event.updates.private === false ||
                event.updates.private === "false";
            console.log("Updating activity visibility to", isPublic);
            await updateActivityVisibility(id, isPublic);
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
