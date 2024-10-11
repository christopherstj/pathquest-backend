import StravaEvent from "./StravaEvent";

export default interface QueueMessage {
    action: string;
    created: string;
    started?: string;
    completed?: string;
    jsonData?: string;
    isWebhook: boolean;
}
