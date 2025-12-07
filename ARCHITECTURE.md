# PathQuest Backend Architecture

## Overview
PathQuest Backend consists of multiple serverless workers that process Strava webhook events, handle activity processing, manage message queues, and reset rate limits. These workers run independently and communicate via Google Cloud Pub/Sub and PostgreSQL.

## Workers

### 1. Activity Processor (`activity-processor/`)
**Purpose**: Receives Strava webhook events and adds them to the processing queue.

**Entry Point**: `src/index.ts`
- **Port**: 8080
- **Framework**: Fastify

**Routes**:
- `POST /webhook` - Receives Strava webhook events (create/update/delete activities)
  - Validates webhook payload
  - Creates `QueueMessage` with priority 1
  - Adds message to `event_queue` table via `addEventToQueue`
- `GET /webhook` - Webhook verification endpoint for Strava
  - Validates `hub.verify_token` against `STRAVA_VERIFY_TOKEN`
  - Returns `hub.challenge` for verification

**Helpers**:
- `addEventToQueue` - Inserts webhook events into `event_queue` table
- `getCloudSqlConnection` - Database connection pool

**Type Definitions**:
- `StravaEvent` - Strava webhook payload structure
- `QueueMessage` - Internal queue message format

**Flow**:
1. Strava sends webhook → Activity Processor receives it
2. Creates queue message with `is_webhook: true`, `priority: 1`
3. Inserts into `event_queue` table
4. Returns 200 to Strava

---

### 2. Queue Handler (`queue-handler/`)
**Purpose**: Polls the database for queued messages and publishes them to Pub/Sub for processing.

**Entry Point**: `index.ts`
- **Port**: 8080
- **Framework**: Fastify

**Routes**:
- `POST /` - Triggers message processing
  - Calls `processMessages()` synchronously
  - Returns immediately (processing happens in background)

**Helpers**:
- `processMessages` - Main processing function
  - Gets messages to process via `getMessagesToProcess`
  - Publishes messages to Pub/Sub topic (batched, max 10 messages per batch, 60s timeout)
  - Marks messages as completed on success
  - Handles errors by marking messages with error status
- `getMessagesToProcess` - Determines how many messages to process
  - Checks rate limits via `checkRateLimit`
  - Gets message count via `getNumberOfMessages`
  - Limits to min(30, allowedProcessing, numberOfMessages)
  - Retrieves messages via `getMostRecentMessage`
- `getMostRecentMessage` - Retrieves oldest unprocessed messages from queue
- `getNumberOfMessages` - Counts pending messages in queue
- `checkRateLimit` - Checks if Strava API rate limits allow processing
- `completeMessage` - Marks message as completed or sets error
- `getCloudSqlConnection` - Database connection
- `getStravaAccessToken` - Gets Strava OAuth token (for rate limit checking)
- `saveStravaCreds` - Updates Strava credentials
- `setUsageData` - Updates rate limit usage tracking
- `resetShortTermUsage` - Resets short-term rate limit usage

**Pub/Sub Configuration**:
- Topic name from `PUBSUB_TOPIC` environment variable
- Batching: max 10 messages, 60 second timeout

**Flow**:
1. Scheduled job calls `POST /`
2. `processMessages()` retrieves messages from `event_queue` table
3. Publishes messages to Pub/Sub topic
4. Activity Worker consumes messages from Pub/Sub

---

### 3. Activity Worker (`activity-worker/`)
**Purpose**: Consumes messages from Pub/Sub, processes Strava activities, detects peak summits, and updates the database.

**Entry Point**: `index.ts`
- **Port**: 8080
- **Framework**: Fastify

**Routes**:
- `POST /` - Receives Pub/Sub messages
  - Validates Pub/Sub message format
  - Parses base64-encoded message data
  - Calls `retrieveMessage()` to process
  - Returns 200 immediately (async processing)
- `POST /test` - **UNUSED** - Test endpoint for fetching Strava activity descriptions
  - Takes `ownerId` and `objectId`
  - Fetches activity description from Strava
  - Logs result

**Helpers**:
- `retrieveMessage` - Main message processor
  - Routes to appropriate handler based on `action` field:
    - `create` → `processMessage` (processes new activities)
    - `update` → `processUpdateMessage` (handles activity updates)
    - `delete` → `processDeleteMessage` (handles activity deletions)
  - Marks message as started via `setMessageStarted`
  - Marks message as completed via `completeMessage`
- `processMessage` - Processes new activity creation
  - Fetches activity from Strava via `getStravaActivity`
  - Optionally updates Strava description if webhook and user has description updates enabled
  - **Note**: This appears to be a stub - actual activity processing logic may be elsewhere
- `processUpdateMessage` - Handles activity updates
  - Updates activity title if changed
  - Updates activity sport type if changed
  - Updates activity visibility (public/private) if changed
- `processDeleteMessage` - Handles activity deletions
  - Calls `deleteActivity` to remove from database
  - Optionally deletes associated manual peak entries
- `saveActivity` - Saves activity data to database
  - Inserts/updates `activities` table with:
    - Coordinates (PostGIS geometry)
    - Distance, elevation profile, streams
    - Start time, sport type, title, timezone
    - Public/private status
- `saveActivitySummits` - Saves detected peak summits
  - Inserts into `activities_peaks` table
- `getSummits` - Core algorithm for detecting peak summits from coordinate data
  - Takes coordinate stream and peak locations
  - Detects when activity path comes within threshold distance of peak
  - Handles multiple summits of same peak (resets after moving away)
- `processCoords` - Processes coordinate data for summit detection
- `getStravaActivity` - Fetches activity data from Strava API
- `getStravaDescription` - Gets current activity description from Strava
- `updateStravaDescription` - Updates activity description on Strava
- `getShouldUpdateDescription` - Checks if user has description updates enabled
- `getStravaAccessToken` - Gets OAuth token for Strava API
- `deleteActivity` - Removes activity and associated data
- `updateActivityTitle` - Updates activity title in database
- `updateActivityVisibility` - Updates activity visibility in database
- `getHistoricalWeatherByCoords` - Fetches weather data for coordinates (may be unused)
- `compareCoords` - Compares coordinate arrays
- `distanceMetersToDegrees` - Converts distance in meters to degrees
- `getBoundingBox` - Calculates bounding box for coordinate set
- `checkRateLimit` - Checks Strava API rate limits
- `setUsageData` - Updates rate limit usage tracking
- `setMessageStarted` - Marks queue message as started
- `completeMessage` - Marks queue message as completed
- `resetShortTermUsage` - Resets short-term rate limit
- `saveStravaCreds` - Updates Strava credentials
- `getCloudSqlConnection` - Database connection pool

**Type Definitions**:
- `QueueMessage` - Queue message structure
- `StravaEvent` - Strava webhook event structure
- `StravaActivity` - Strava activity data structure
- `StravaStream` - Coordinate/elevation stream data
- `Peak` - Peak location data
- `ActivityPeak` - Junction table entry
- `StravaCreds` - OAuth credentials
- `StravaRateLimit` - Rate limit tracking data
- `StravaTokenResponse` - Token refresh response

**Flow**:
1. Pub/Sub delivers message → Activity Worker receives
2. `retrieveMessage()` routes to appropriate handler
3. Handler processes activity (create/update/delete)
4. For creates: fetches activity data, detects summits, saves to database
5. Marks message as completed

---

### 4. Rate Limit Reset (`rate-limit-reset/`)
**Purpose**: Scheduled worker that resets Strava API rate limit counters.

**Entry Point**: `index.ts`
- **Port**: 8080
- **Framework**: Fastify

**Routes**:
- `POST /` - Resets long-term (daily) rate limits
  - Sets both `short_term_usage` and `daily_usage` to 0
- `POST /short-term` - Resets short-term rate limits only
  - Sets `short_term_usage` to 0

**Helpers**:
- `resetRateLimit` - Resets both short-term and daily usage
- `resetShortTermUsage` - Resets only short-term usage
- `getCloudSqlConnection` - Database connection

**Flow**:
1. Scheduled job calls endpoint (likely daily for `/`, more frequently for `/short-term`)
2. Updates `strava_rate_limits` table
3. Resets usage counters

---

## Data Flow

### Activity Creation Flow
1. User uploads activity to Strava
2. Strava sends webhook → **Activity Processor** (`POST /webhook`)
3. Activity Processor creates queue message → inserts into `event_queue`
4. **Queue Handler** (`POST /`) polls database → publishes to Pub/Sub
5. **Activity Worker** consumes from Pub/Sub → processes activity
6. Activity Worker:
   - Fetches activity data from Strava API
   - Processes coordinates to detect peak summits
   - Saves activity and summits to database
   - Optionally updates Strava activity description

### Activity Update Flow
1. User updates activity on Strava (title, visibility, etc.)
2. Strava sends webhook → **Activity Processor**
3. Queue Handler publishes to Pub/Sub
4. **Activity Worker** processes update → updates database

### Activity Delete Flow
1. User deletes activity on Strava
2. Strava sends webhook → **Activity Processor**
3. Queue Handler publishes to Pub/Sub
4. **Activity Worker** processes delete → removes from database

### Rate Limit Management
- **Queue Handler** checks rate limits before processing messages
- **Activity Worker** tracks usage after each Strava API call
- **Rate Limit Reset** worker resets counters on schedule

## Database Tables Used

### `event_queue`
- Stores messages waiting to be processed
- Fields: `id`, `action`, `created`, `json_data`, `is_webhook`, `user_id`, `priority`, `started`, `completed`, `error`

### `activities`
- Stores Strava activity data
- Fields: `id`, `user_id`, `start_coords`, `coords`, `distance`, `vert_profile`, `distance_stream`, `time_stream`, `start_time`, `sport`, `title`, `timezone`, `gain`, `is_public`, `activity_json`

### `activities_peaks`
- Junction table linking activities to summitted peaks
- Fields: `id`, `activity_id`, `peak_id`, `timestamp`, `notes`, `is_public`

### `strava_rate_limits`
- Tracks Strava API rate limit usage
- Fields: `short_term_limit`, `short_term_usage`, `daily_limit`, `daily_usage`

### `strava_creds`
- Stores OAuth tokens for Strava API access
- Fields: `user_id`, `access_token`, `refresh_token`, `expires_at`

## Environment Variables

### Activity Processor
- `STRAVA_VERIFY_TOKEN` - Token for webhook verification

### Queue Handler
- `PUBSUB_TOPIC` - Google Cloud Pub/Sub topic name

### All Workers
- Database connection variables (Cloud SQL)
- Strava OAuth credentials

## Notes

### Unused Code
- **Activity Worker** `/test` endpoint - Test endpoint, likely not used in production
- `getHistoricalWeatherByCoords` - May be unused or planned feature

### Processing Logic
The actual activity processing (fetching streams, detecting summits) appears to be handled by `processMessage`, but the implementation may delegate to other services or the logic may be incomplete. The `getSummits` helper contains the core summit detection algorithm.

### Error Handling
- Messages that fail processing are marked with error status
- Failed messages can be retried (they remain in queue if not completed)
- Rate limit errors prevent processing new messages

### Scalability
- Workers are designed to be stateless and horizontally scalable
- Pub/Sub provides message distribution across multiple worker instances
- Database connection pooling handles concurrent connections

