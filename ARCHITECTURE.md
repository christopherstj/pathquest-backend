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
- `getMessagesToProcess` - Determines how many messages to process with webhook priority
  - Counts pending webhook messages separately
  - Always processes ALL pending webhooks immediately (burst mode for real-time experience)
  - Applies sustainable rate only to historical (non-webhook) messages
  - Combines webhook count + sustainable historical count for total
  - Cap of 50 messages per run for safety
- `getMostRecentMessage` - Retrieves oldest unprocessed messages from queue (ordered by priority ASC)
- `getNumberOfMessages` - Counts pending messages in queue
- `checkRateLimit` - Calculates sustainable rate limit allowance
  - Distributes daily API budget evenly across remaining hours until midnight UTC reset
  - Reserves 2% of daily budget for webhook bursts (~60 requests for ~15 athletes)
  - Respects short-term (15-minute) limits
  - Returns activities-per-run (not requests) accounting for 2 requests per activity
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
  - Takes coordinate stream (points with lat/lng/time/altitude) and peak locations
  - Uses multi-factor confidence scoring system (not just distance threshold)
  - Returns summit candidates with confidence scores and needs_confirmation flags
  - Confidence factors: distance, elevation match, approach pattern, dwell time
  - Supports 4 detection modes based on data availability:
    - Mode A: Full data (GPS altitude + peak elevation) - all 4 factors
    - Mode B: GPS altitude only - distance, approach pattern, dwell
    - Mode C: Peak elevation only - stricter distance + dwell
    - Mode D: No elevation data - strictest distance + dwell requirements
  - Uses haversine distance calculations for accurate detection
  - Handles multiple summits of same peak (resets after moving away)
- `getSummits` - Helper function for aggregating summit data
  - Used internally for tracking multiple summit instances
  - Manages reset logic for repeated peak visits
- `processCoords` - Processes coordinate data for summit detection
  - Queries database for peaks within bounding box of activity
  - Filters candidate peaks using distance calculations
  - Passes altitude data to `detectSummits` for confidence scoring
  - Returns detected summit candidates with confidence scores
- `haversineDistanceMeters` - Calculates distance between two lat/lng points using haversine formula
- `summitConfig` - Configuration constants for summit detection
  - `SUMMIT_CONFIG` - Mode-specific configuration (A/B/C/D) with enterDistance, exitDistance, threshold, and feature flags
  - `CONFIDENCE_THRESHOLDS` - Thresholds for auto-accept (0.55), needs confirmation (0.45), and reject
  - `ELEVATION_TOLERANCE` - Allowance for GPS elevation error (75m)
  - `ELEVATION_PENALTY_RATE` - Rate of confidence decay for elevation mismatch
  - `ENTER_DISTANCE_METERS` - Legacy distance threshold (mode-specific in SUMMIT_CONFIG)
  - `EXIT_DISTANCE_METERS` - Legacy exit distance (mode-specific in SUMMIT_CONFIG)
  - `MIN_DWELL_SECONDS` - Minimum time spent near peak
  - `MIN_POINTS` - Minimum coordinate points required
  - `RESET_GAP_SECONDS` - Time gap before resetting summit detection
  - `SEARCH_RADIUS_METERS` - Radius for initial peak search
  - `MAX_CANDIDATE_PEAKS` - Maximum peaks to consider per activity
  - `getSummitMode()` - Helper to determine detection mode from data availability
- `getStravaActivity` - Fetches activity data from Strava API and processes for summit detection
  - Filters out non-human-powered activities (see Excluded Sport Types below)
- `getStravaDescription` - Builds the PathQuest Strava activity description (summits + lightweight celebrations)
  - Adds peak elevation (feet) when available: `Peak Name (5,344 ft)`
  - Adds a celebration for first-time summits of a peak: `Peak Name (5,344 ft) - first summit! 🎉`
  - Adds a personal record callout when the activity beats the user's previous highest peak: `⭐ New highest peak!`
  - Adds a location unlock callout for first peak in a new state/country: `🏳️ First peak in Colorado!`
  - Adds per-peak challenge progress lines when the summit represents new progress (first-time summit of that peak): `🗻 completed/total Challenge Name`
  - Adds a completion celebration when a challenge becomes complete: `🏆 Challenge Name COMPLETE!`
  - Includes internal monthly streak calculation logic (ported from profile stats) but does not currently render streak text in the Strava description output
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
- `resetRateLimit(pool)` - Resets both short-term and daily usage (accepts Pool parameter)
- `resetShortTermUsage(pool)` - Resets only short-term usage (accepts Pool parameter)
- `getCloudSqlConnection` - Returns PostgreSQL connection pool (uses `pg` library)

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
- Fields: `id`, `activity_id`, `peak_id`, `timestamp`, `notes`, `is_public`, `confidence_score`, `needs_confirmation`, plus weather fields

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
  - `id` (varchar, PK), `timestamp` (timestamp), `activity_id` (varchar), `peak_id` (varchar), `notes` (varchar), `is_public` (boolean), `temperature` (numeric), `precipitation` (numeric), `cloud_cover` (numeric), `wind_speed` (numeric), `wind_direction` (numeric), `weather_code` (int), `tags` (text[]), `humidity` (numeric), `confidence_score` (numeric 0.0-1.0), `needs_confirmation` (boolean)

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
1. Fetches activity metadata from Strava API
2. Checks if activity sport type is human-powered (skips excluded types)
3. Fetches activity stream data from Strava API
4. Processes coordinates via `processCoords` which:
   - Queries database for nearby peaks
   - Filters candidates using bounding box and distance calculations
   - Calls `detectSummits` to detect actual summits using haversine distance
3. Fetches historical weather data for each detected summit
4. Saves activity and summit data to database
5. Generates description with summit information

The `detectSummits` helper contains the core summit detection algorithm, using configurable thresholds from `summitConfig`.

### Excluded Sport Types
Activities with the following `sport_type` values are skipped (not processed for summit detection):
- `AlpineSki` - Lift-assisted downhill skiing
- `Snowboard` - Lift-assisted downhill
- `Sail` - Wind-powered
- `Windsurf` - Wind-powered
- `Kitesurf` - Wind-powered
- `VirtualRide` - Indoor/simulated (no real summits)
- `VirtualRun` - Indoor/simulated (no real summits)
- `Golf` - Not relevant to peak bagging
- `Velomobile` - Often aerodynamically assisted

Human-powered activities like `BackcountrySki`, `NordicSki`, `Hike`, `Run`, `Ride`, `EBikeRide`, `EMountainBikeRide`, etc. are processed normally.

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

---

## Data Backup / Import Tools (`data-backup/`)

### Challenge Import Pipeline

Tools for importing peak challenges from external sources (e.g., Peakbagger.com) and matching them to existing OSM peaks in the database.

**Entry Point**: `src/index.ts` → `importChallenge.ts`

**Scripts**:
- `scrapePeakbaggerList.ts` - Scrapes peak lists from Peakbagger.com
  - Fetches list page to get peak names and IDs
  - Fetches individual peak pages to get coordinates
  - Caches results to JSON file for reuse
- `matchPeaksToOsm.ts` - Matches external peaks to OSM database
  - Uses PostGIS `ST_DWithin` for proximity matching (500m radius)
  - Scores candidates by: name similarity (50%), distance (30%), elevation (20%)
  - Confidence levels: high (< 100m + 70% name), medium (< 300m + 40% name), low
- `insertChallenge.ts` - Inserts challenges and peak associations
  - Supports dry-run mode (default)
  - Exports review JSON for manual verification
  - Imports reviewed JSON with manual edits

**Type Definitions** (`typeDefs/ChallengeImport.ts`):
- `ExternalPeak` - Peak data from external source
- `ChallengeDefinition` - Challenge metadata
- `MatchResult` - OSM match result with confidence
- `PEAKBAGGER_LISTS` - Predefined Peakbagger list configurations

**Usage**:
```bash
# Show help and list existing challenges
npm run dev:once

# Scrape from Peakbagger (dry run)
PEAKBAGGER_LIST_ID=5120 npm run dev:once

# Insert for real
DRY_RUN=false PEAKBAGGER_LIST_ID=5120 npm run dev:once

# Import from reviewed JSON
DRY_RUN=false REVIEW_FILE=review-5120.json npm run dev:once
```

**Environment Variables**:
- `PEAKBAGGER_LIST_ID` - Peakbagger list ID to scrape
- `PEAKS_JSON_FILE` - Path to JSON file with peak data
- `REVIEW_FILE` - Path to reviewed match results
- `DRY_RUN` - Set to "false" to actually insert (default: true)
- `INCLUDE_LOW_CONFIDENCE` - Set to "true" to include low confidence matches
- `CHALLENGE_ID`, `CHALLENGE_NAME`, `CHALLENGE_REGION`, `CHALLENGE_DESCRIPTION` - Override challenge metadata

**Predefined Peakbagger Lists**:
- `5120` - Adirondack 46ers
- `21364` - Colorado 13ers (All: ranked + unranked) — recommended seed list for peak ingestion
- `5061` - Colorado Ranked 13ers (legacy / ranked-only list)
- `5071` - Colorado Soft 13ers
- `5012` - Washington Bulger List
- `5001` - Cascade Volcanoes
- `6031` - Catskill 35
- And more (see `PEAKBAGGER_LISTS` in typeDefs)

---

### Peak Data Enrichment (Geocoding + Elevation)

The `data-backup/` package also contains one-off enrichment scripts that improve the `peaks` catalog quality.

#### PostGIS-based Geocoding (Recommended)

Instead of API-based reverse geocoding (slow and quota-limited), PathQuest can geocode peaks by loading administrative boundary polygons into PostGIS and running spatial joins.

**Scripts**:
- `src/importAdminBoundaries.ts` — Downloads and imports admin boundary shapefiles into PostGIS tables:
  - `admin_countries` (Natural Earth admin-0 countries)
  - `admin_states` (Natural Earth admin-1 states/provinces)
  - `admin_us_counties` (US Census counties)
- `src/enrichGeocodingPostGIS.ts` — Batches `UPDATE ... FROM ... ST_Contains(...)` to populate `peaks.country`, `peaks.state`, and `peaks.county` with observable progress.

**Batch Controls** (env vars):
- `GEOCODING_POSTGIS_BATCH_SIZE` (default `50000`) — number of peaks updated per batch
- `GEOCODING_POSTGIS_MAX_BATCHES` (optional) — stop after N batches (useful for testing)
- `GEOCODING_POSTGIS_PRINT_EVERY` (default `1`) — print progress every N batches

**Notes**:
- Each batch is a separate SQL statement, so progress commits incrementally and can be monitored.
- Queries use a bounding-box prefilter (`&&`) plus `ST_Contains` to ensure GiST index usage.

---

#### Public Lands Enrichment (US PAD-US)

PathQuest can tag US peaks with public land / protected area metadata by importing **PAD-US** polygons into PostGIS and running a point-in-polygon join.

**Scripts**:
- `pathquest-backend/data-backup/src/importPublicLands.ts`
  - Supports **PAD-US FileGDB** (`.gdb`, optionally inside a `.zip`) via **GDAL** (`ogrinfo`, `ogr2ogr`)
  - Also supports a **Shapefile fallback** (Node.js `shapefile` parser) when GDB tooling is unavailable
  - Imports polygons into `public_lands` with `geom` stored as **GEOMETRY** and a **GiST** index for fast joins
- `pathquest-backend/data-backup/src/enrichPeaksWithPublicLands.ts`
  - Batches updates to populate:
    - `peaks.protected_area_name`
    - `peaks.protected_area_type`
    - `peaks.land_manager`
  - Uses `ST_Contains(public_lands.geom, peaks.location_geom)` (geometry + GiST) for performance

**Data placement**:
- Put PAD-US assets in: `pathquest-backend/data-backup/geodata/padus/`
  - Example: `PADUS4_1Geodatabase.zip` (script extracts and finds `.gdb`)

**GDB Requirements**:
- GDAL must be available on PATH for the shell running `npm run dev:once`
  - `ogrinfo` and `ogr2ogr` must be callable

**Import tuning (optional env vars)**:
- `PADUS_GDB_LAYER`: override which GDB layer to import (e.g. `PADUS4_1Fee`)
- `PADUS_OGR_WHERE`: OGR WHERE clause to filter rows at import time (reduces size)
- `PADUS_OGR_SELECT`: comma-separated list of columns to import (reduces width)
- `PADUS_OGR_GT`: transaction group size for `ogr2ogr` (default `65536`)

---

### Peak External IDs + Peakbagger Peak Ingest (Seed List)

To support multiple upstream sources per peak (OSM, Peakbagger, GNIS, Wikidata, etc.), PathQuest uses a junction table.

**Table**: `peak_external_ids`
- **PK**: `(peak_id, source)` (one external ID per source per peak)
- **Unique**: `(source, external_id)` (an external ID can’t map to multiple peaks)

**Peaks provenance/snapping columns**
- `peaks.source_origin` — `osm | peakbagger | manual | unknown`
- `peaks.seed_coords` — original seed coordinate for snapping (geometry Point)
- `peaks.snapped_coords`, `snapped_distance_m`, `snapped_dem_source`, `coords_snapped_at`, `needs_review`

**psql schema + backfills** (recommended to run explicitly via psql)
- `pathquest-backend/data-backup/sql/001_peaks_provenance_and_external_ids.sql`
- `pathquest-backend/data-backup/sql/002_backfill_peaks_provenance.sql`
- `pathquest-backend/data-backup/sql/003_backfill_peak_external_ids.sql`

Run example:
```bash
psql -h 127.0.0.1 -p 5432 -U local-user -d operations -v ON_ERROR_STOP=1 -f pathquest-backend/data-backup/sql/001_peaks_provenance_and_external_ids.sql
```

**Peakbagger list ingestion (Colorado 13ers seed list: 21364)**
- Script: `pathquest-backend/data-backup/src/importPeakbaggerPeaks.ts`
- Entry: `pathquest-backend/data-backup/src/index.ts` via `TASK=import-peakbagger-peaks`

Usage:
```bash
# Dry-run: scrape + 1:1 match outputs (matched-high / matched-review / unmatched)
TASK=import-peakbagger-peaks PEAKBAGGER_LIST_ID=21364 DRY_RUN=true npm run dev:once

# Apply: link matched-high + insert unmatched (new peaks use UUID ids)
TASK=import-peakbagger-peaks PEAKBAGGER_LIST_ID=21364 DRY_RUN=false npm run dev:once
```

Outputs:
- `pb-<listId>-matched-high.json`
- `pb-<listId>-matched-review.json`
- `pb-<listId>-unmatched.json`
- `pb-<listId>-skipped-already-linked.json`

**Climb13ers ingestion (fallback when Peakbagger is Cloudflare-blocked)**
- Script: `pathquest-backend/data-backup/src/importClimb13ersPeaks.ts`
- Entry: `pathquest-backend/data-backup/src/index.ts` via `TASK=import-climb13ers-peaks`

Usage:
```bash
# You must provide a list page URL that contains many peak links
TASK=import-climb13ers-peaks CLIMB13ERS_LIST_URL="https://www.climb13ers.com/..." DRY_RUN=true npm run dev:once

# Limit for testing
TASK=import-climb13ers-peaks CLIMB13ERS_LIST_URL="https://www.climb13ers.com/..." CLIMB13ERS_MAX_PEAKS=25 DRY_RUN=true npm run dev:once

# Apply: link matched-high + insert unmatched (new peaks use UUID ids)
TASK=import-climb13ers-peaks CLIMB13ERS_LIST_URL="https://www.climb13ers.com/..." DRY_RUN=false npm run dev:once
```

Notes:
- The scraper detects Cloudflare “challenge” HTML and fails fast (instead of silently parsing bad pages).
- External IDs are stored as `peak_external_ids(source='climb13ers', external_id='<peak page url>')`.

---

**14ers.com ingestion (preferred for Colorado 13ers when coordinates matter)**

14ers.com provides **high-quality decimal Lat/Lon** on each peak page (and often LiDAR-adjusted elevations), which makes it a better seed source than Climb13ers when you plan to run snap-to-highest.

- Script: `pathquest-backend/data-backup/src/import14ersPeaks.ts`
- Scraper: `pathquest-backend/data-backup/src/scrape14ers.ts`
- Entry: `pathquest-backend/data-backup/src/index.ts` via `TASK=import-14ers-peaks`

Usage:
```bash
# Dry-run: scrape + 1:1 match outputs (matched-high / matched-review / unmatched)
TASK=import-14ers-peaks DRY_RUN=true npm run dev:once

# Limit for testing
TASK=import-14ers-peaks FOURTEENERS_MAX_PEAKS=25 DRY_RUN=true npm run dev:once

# Apply: link matched-high + approved reviews + insert unmatched (new peaks use UUID ids)
TASK=import-14ers-peaks DRY_RUN=false npm run dev:once
```

Notes:
- The 13ers list page includes **ranked + unranked** and may include additional peaks; expect **hundreds** of rows (e.g. ~800+ depending on site filters/data).
- External IDs are stored as `peak_external_ids(source='14ers', external_id='<peak page url>')`.
- By default, the ingest updates the peak's **primary location** (`peaks.location_coords` + `peaks.location_geom` where present) to the 14ers Lat/Lon. To disable: `SET_PRIMARY_FROM_14ERS=false`.
- If you want the 14ers coordinates to also become the snap seed coords, set `SET_SEED_FROM_14ERS=true` during ingest.
- The scraper also captures list metadata (when present) into `peaks-14ers.json` for later challenge creation:
  - `peakId` (14ers internal numeric id from the URL)
  - `coRank` and `thirteenRank` (ranked peaks have these; unranked may be blank)
  - `range` and `elevationFeet`

---

### Snap-to-highest (3DEP) for US peaks (VM-friendly)
PathQuest supports refining peak coordinates by snapping seed coordinates to the highest DEM cell within a radius.

**Implementation**
- Node orchestrator: `pathquest-backend/data-backup/src/snapPeaksToHighest3dep.ts`
- Python helper (raster sampling): `pathquest-backend/data-backup/python/snap_to_highest.py`
- VM setup notes: `pathquest-backend/data-backup/docs/dem-setup-vm.md` (includes 3DEP 10m baseline + optional LiDAR DEM notes)

**Run**
```bash
TASK=snap-peaks-3dep DEM_VRT_PATH=/path/to/co_3dep.vrt npm run dev:once
```

**Key env vars**
- `DEM_VRT_PATH` (required)
- `PYTHON_BIN` (default `python3`)
- `SNAP_STATE` (default `CO`)
- `SNAP_ELEVATION_MIN_M` (default `3962`)
- `SNAP_BATCH_SIZE` (default `500`)
- `SNAP_ACCEPT_MAX_DISTANCE_M` (default `300`)
- `SNAP_RADIUS_OSM_M` (default `250`)
- `SNAP_RADIUS_PEAKBAGGER_M` (default `150`)
- `SNAP_DRY_RUN=true` — run the snap calculation and print results **without writing to the DB**
- `SNAP_PEAK_IDS` — comma-separated list of `peaks.id` to snap (stops after one batch)
- `SNAP_PEAK_NAME_ILIKE` — target peaks by name using SQL `ILIKE` (e.g. `'%Elbert%'`) (stops after one batch)

**Public lands correctness after snapping**
- When a peak is accepted (primary location updated), the snap script resets public-lands state:
  - sets `peaks.public_lands_checked = FALSE` (if column exists)
  - deletes existing `peaks_public_lands` rows for that peak
  - so the next `enrichPeaksWithPublicLands` run re-computes land membership.

Post-snap convenience task:
```bash
TASK=post-snap-enrichment npm run dev:once
```
