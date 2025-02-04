export default interface QueueMessage {
    userId: string;
    action: string;
    created: string;
    started?: string;
    completed?: string;
    jsonData?: string;
    isWebhook: boolean;
    priority: number;
}
