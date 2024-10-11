import StravaEvent from "./StravaEvent";

export default interface QueueMessage {
    id: number;
    action: string;
    created: string;
    started?: string;
    completed?: string;
    jsonData?: any;
    isWebhook: boolean;
}
