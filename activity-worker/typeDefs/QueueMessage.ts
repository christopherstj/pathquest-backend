export default interface QueueMessage {
    id?: number;
    action: string;
    created: string;
    started?: string;
    completed?: string;
    json_data?: any;
    is_webhook: boolean;
}
