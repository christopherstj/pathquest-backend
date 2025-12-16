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
  - Validates Pub/Sub message format and base64 payload shape
  - Parses base64-encoded message data
  - Calls `retrieveMessage()` to process
  - Returns 200 immediately (async processing)

**Helpers**:
- `retrieveMessage` - Main message processor
  - Routes to appropriate handler based on `action` field:
    - `create` → `processMessage` (processes new activities)
    - `update` → `processUpdateMessage` (handles activity updates)
    - `delete` → `processDeleteMessage` (handles activity deletions)
  - Marks message as started via `setMessageStarted`
  - Marks message as completed via `completeMessage`
  - Parses and validates event payload once and propagates structured errors to queue completion
- `processMessage` - Processes new activity creation
  - Fetches activity from Strava via `getStravaActivity` (which handles full processing)
  - `getStravaActivity` performs complete activity processing:
    - Fetches activity data and streams from Strava API
    - Processes coordinates via `processCoords` to detect peak summits
    - Saves activity to database via `saveActivity`
    - Saves detected summits via `saveActivitySummits`
    - Fetches historical weather data for summits
    - Generates and optionally updates Strava description
  - Returns description string if webhook and user has description updates enabled
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
- `detectSummits` - Core algorithm for detecting peak summits from coordinate data
  - Takes coordinate stream (points with lat/lng/time) and peak locations
  - Detects when activity path comes within threshold distance of peak
  - Uses haversine distance calculations for accurate detection
  - Handles multiple summits of same peak (resets after moving away)
  - Returns summit candidates with minimum distance points
- `getSummits` - Helper function for aggregating summit data
  - Used internally for tracking multiple summit instances
  - Manages reset logic for repeated peak visits
- `processCoords` - Processes coordinate data for summit detection
  - Queries database for peaks within bounding box of activity
  - Filters candidate peaks using distance calculations
  - Calls `detectSummits` to find actual summits
  - Returns detected summit candidates
- `haversineDistanceMeters` - Calculates distance between two lat/lng points using haversine formula
- `summitConfig` - Configuration constants for summit detection
  - `ENTER_DISTANCE_METERS` - Distance threshold for entering summit zone
  - `EXIT_DISTANCE_METERS` - Distance threshold for exiting summit zone
  - `MIN_DWELL_SECONDS` - Minimum time spent near peak
  - `MIN_POINTS` - Minimum coordinate points required
  - `RESET_GAP_SECONDS` - Time gap before resetting summit detection
  - `SEARCH_RADIUS_METERS` - Radius for initial peak search
  - `MAX_CANDIDATE_PEAKS` - Maximum peaks to consider per activity
- `getStravaActivity` - Fetches activity data from Strava API
- `getStravaDescription` - Gets current activity description from Strava
- `updateStravaDescription` - Updates activity description on Strava
- `getShouldUpdateDescription` - Checks if user has description updates enabled
- `getStravaAccessToken` - Gets OAuth token for Strava API
- `getHistoricalWeatherByCoords` - Fetches archived weather data for summit enrichment
- `deleteActivity` - Removes activity and associated data
- `updateActivityTitle` - Updates activity title in database
- `updateActivityVisibility` - Updates activity visibility in database
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

### Automated Tests (activity-worker)
- `npm test` / `npm run test:unit` executes Vitest unit tests
- Coverage includes message routing (`retrieveMessage`) and summit detection (`detectSummits`)
- Test files: `tests/retrieveMessage.test.ts`, `tests/detectSummits.test.ts`

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

### `strava_tokens`
- Stores OAuth tokens for Strava API access
- Fields: `user_id`, `access_token`, `refresh_token`, `access_token_expires_at`

## Database Schema (PostgreSQL `operations`)

Tables (excluding legacy `_old` tables and `spatial_ref_sys`):

- `activities` — user Strava activities  
  - `id` (varchar, PK), `user_id` (varchar), `start_coords` (geography), `distance` (numeric), `coords` (geography), `start_time` (timestamp), `sport` (varchar), `title` (text), `timezone` (varchar), `gain` (numeric), `vert_profile` (json), `title_manually_updated` (boolean), `distance_stream` (json), `time_stream` (json), `pending_reprocess` (boolean), `is_public` (boolean), `activity_json` (json)

- `activities_peaks` — summits detected per activity  
  - `id` (varchar, PK), `timestamp` (timestamp), `activity_id` (varchar), `peak_id` (varchar), `notes` (varchar), `is_public` (boolean), `temperature` (numeric), `precipitation` (numeric), `cloud_cover` (numeric), `wind_speed` (numeric), `wind_direction` (numeric), `weather_code` (int), `tags` (text[]), `humidity` (numeric)

- `challenges` — challenge definitions  
  - `id` (int, PK), `name` (varchar), `region` (varchar), `location_coords` (geography), `description` (text)

- `event_queue` — processing queue for webhook events  
  - `id` (int, PK), `action` (varchar), `created` (timestamp), `started` (timestamp), `completed` (timestamp), `json_data` (json), `is_webhook` (boolean), `error` (varchar), `attempts` (int), `user_id` (varchar), `priority` (int)

- `peaks` — peak catalog  
  - `id` (varchar, PK), `name` (varchar), `location_coords` (geography), `elevation` (numeric), `county` (varchar), `state` (varchar), `country` (varchar), `type` (varchar), `osm_object` (json)

- `peaks_challenges` — peak-to-challenge mapping  
  - `peak_id` (varchar), `challenge_id` (int)

- `strava_rate_limits` — cached Strava rate usage  
  - `id` (int, PK), `short_term_limit` (int), `daily_limit` (int), `short_term_usage` (int), `daily_usage` (int)

- `strava_tokens` — Strava OAuth tokens  
  - `user_id` (varchar, PK), `refresh_token` (varchar), `access_token` (varchar), `access_token_expires_at` (int)

- `user_challenge_favorite` — user favorites for challenges  
  - `user_id` (varchar), `challenge_id` (int), `is_public` (boolean)

- `user_interest` — waitlist/interest capture  
  - `email` (varchar), `date_registered` (timestamp)

- `user_peak_favorite` — user favorites for peaks  
  - `user_id` (varchar), `peak_id` (varchar)

- `user_peak_manual` — manual summit entries  
  - `id` (varchar, PK), `user_id` (varchar), `peak_id` (varchar), `notes` (text), `activity_id` (varchar), `is_public` (boolean), `timestamp` (timestamp), `timezone` (varchar), `temperature` (numeric), `precipitation` (numeric), `cloud_cover` (numeric), `wind_speed` (numeric), `wind_direction` (numeric), `weather_code` (int), `tags` (text[]), `humidity` (numeric)

- `users` — user profiles  
  - `id` (varchar, PK), `name` (text), `email` (varchar), `pic` (text), `update_description` (boolean), `city` (varchar), `state` (varchar), `country` (varchar), `location_coords` (geography), `units` (varchar), `is_subscribed` (boolean), `is_lifetime_free` (boolean), `stripe_user_id` (varchar), `historical_data_processed` (boolean), `is_public` (boolean), `created_at` (timestamp)

Notes:
- Geography/geometry columns show as `USER-DEFINED` in `information_schema` (PostGIS).
- Legacy tables present: `activities_old`, `peaks_old`, `users_old` (not in active use).

## Environment Variables

### Activity Processor
- `STRAVA_VERIFY_TOKEN` - Token for webhook verification

### Queue Handler
- `PUBSUB_TOPIC` - Google Cloud Pub/Sub topic name

### All Workers
- Database connection variables (Cloud SQL)
- Strava OAuth credentials

## Notes

### Processing Logic
Activity processing is fully implemented in `getStravaActivity`:
1. Fetches activity and stream data from Strava API
2. Processes coordinates via `processCoords` which:
   - Queries database for nearby peaks
   - Filters candidates using bounding box and distance calculations
   - Calls `detectSummits` to detect actual summits using haversine distance
3. Fetches historical weather data for each detected summit
4. Saves activity and summit data to database
5. Generates description with summit information

The `detectSummits` helper contains the core summit detection algorithm, using configurable thresholds from `summitConfig`.

### Historical Weather
- `getHistoricalWeatherByCoords` - Fetches archived weather data for summit enrichment
  - Called during activity processing for each detected summit
  - Used to populate weather fields in `activities_peaks` table (temperature, precipitation, cloud cover, wind speed/direction, weather code, humidity)

### Database Table Name Consistency
The codebase consistently uses `strava_rate_limits` (plural) to match the database schema. This includes usage in:
- `activity-worker` helpers
- `queue-handler` helpers
- `rate-limit-reset` helpers

### Error Handling
- Messages that fail processing are marked with error status
- Failed messages can be retried (they remain in queue if not completed)
- Rate limit errors prevent processing new messages

### Scalability
- Workers are designed to be stateless and horizontally scalable
- Pub/Sub provides message distribution across multiple worker instances
- Database connection pooling handles concurrent connections

