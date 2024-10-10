export default interface StravaEvent {
    aspect_type: string;
    event_time: number;
    object_id: number;
    object_type: string;
    owner_id: number;
    subscription_id: number;
}

// {
//     "aspect_type": "update",
//     "event_time": 1516126040,
//     "object_id": 1360128428,
//     "object_type": "activity",
//     "owner_id": 134815,
//     "subscription_id": 120475,
//     "updates": {
//         "title": "Messy"
//     }
// }
