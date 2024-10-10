export default interface StravaTokenResponse {
    token_type: string;
    access_token: string;
    expires_at: number;
    expires_in: number;
    refresh_token: string;
}

// {
//     "token_type": "Bearer",
//     "access_token": "a9b723...",
//     "expires_at":1568775134,
//     "expires_in":20566,
//     "refresh_token":"b5c569..."
//   }
