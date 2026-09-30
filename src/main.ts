// Import required dependencies for GitHub Actions integration, artifact management, and file operations
import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import retry from 'async-retry';

// Constants for artifact management
const DEFAULT_ARTIFACT_NAME = 'last-run';
const DEFAULT_RETENTION_DAYS = 90;
const FILENAME = 'last-run.txt';

const RETRY_OPTIONS = {
  retries: 3,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 10000,
  randomize: false,
} as const;

/**
 * Main entry point for the GitHub Action.
 *
 * Supported modes (input: `mode`):
 *   - `get`          : Retrieve previously stored timestamp (if any) and expose it as `last-run` output.
 *   - `set`          : Store current timestamp (no output produced).
 *   - `get-and-set`  : Retrieve previous timestamp (output) then store a strictly newer timestamp.
 *   - Aliases `getset`, `get_and_set` behave like `get-and-set`.
 *   - Any unknown value logs a warning and behaves like a read-only `get` (no first-run seeding).
 *
 * Failure semantics:
 *   When `fail-if-missing: true` and a valid prior timestamp cannot be retrieved, the action is
 *   marked as failed (core.setFailed). If the selected mode also performs `set` (e.g. `get-and-set`),
 *   the new timestamp upload STILL proceeds. This design ensures subsequent runs have a baseline
 *   timestamp even if the first retrieval attempt failed.
 *
 * First-run seeding:
 *   When `mode: get` is used and no prior timestamp exists (and `fail-if-missing` is false),
 *   the action automatically uploads a fresh timestamp to seed the repository artifact. This
 *   makes the common "since last run" pattern work on the very first invocation without
 *   requiring a separate `set` step. The `first-run` output is `'true'` whenever a `get` finds
 *   no prior timestamp, in both `get` and `get-and-set` modes.
 *
 * Monotonicity:
 *   When a previous timestamp exists, the stored value is at least 1ms later than it, so
 *   consecutive values are strictly increasing even under clock skew or very fast re-runs.
 */
export async function run(): Promise<void> {
  try {
    // Parse action inputs to determine what operations to perform
    const inputs = collectInputs();
    const { mode, failIfMissing, operations } = inputs;
    core.debug(`Effective operations: ${JSON.stringify(operations)} (mode='${mode}')`);

    let retrieved: string | null = null;

    // Retrieve previous timestamp if requested
    if (operations.get) {
      core.startGroup('Retrieve last run timestamp');
      retrieved = await getLastRun(inputs);
      core.endGroup();
    }

    // Always expose a boolean first-run signal for downstream steps.
    const firstRun = operations.get && !retrieved;
    core.setOutput('first-run', firstRun ? 'true' : 'false');

    // First-run seeding: if a caller explicitly requested `get` and no prior timestamp
    // exists (and we aren't failing the run), automatically upload a fresh
    // timestamp so the next run finds a baseline. This makes the common
    // "since last run" pattern work on the very first invocation without
    // requiring the user to pre-seed via a separate `set` step. Unknown modes
    // never seed so a typo can't cause an unexpected write.
    const seed = firstRun && mode === 'get' && !failIfMissing;

    // Store current timestamp if requested (or seed on first run)
    if (operations.set || seed) {
      core.startGroup(seed ? 'Seed first run timestamp' : 'Store current timestamp');
      await setLastRun(retrieved, inputs);
      core.endGroup();
    }
  } catch (error: any) {
    core.setFailed(error.message || String(error));
  }
}

/**
 * Structure for collected action inputs
 */
interface CollectedInputs {
  mode: string;
  failIfMissing: boolean;
  operations: Operations;
  /** Artifact name used to store the timestamp (input: `key`) */
  artifactName: string;
  retentionDays: number;
  token: string | undefined;
}

/**
 * Collects and validates inputs from the GitHub Action configuration.
 * Performs normalization (lower-casing, defaulting) and derives which operations (get/set)
 * will execute. Unknown modes degrade gracefully to `get` to avoid unexpected failures.
 * @returns Parsed and normalized input values
 */
function collectInputs(): CollectedInputs {
  const modeRaw = core.getInput('mode').trim();
  const mode = (modeRaw || 'get').toLowerCase(); // Default to 'get' mode
  const failIfMissing = core.getBooleanInput('fail-if-missing');
  const operations = deriveOperations(mode);
  const key = core.getInput('key').trim();
  const artifactName = sanitizeArtifactName(key) || DEFAULT_ARTIFACT_NAME;
  if (key && artifactName !== key) {
    core.debug(`collectInputs: normalized key '${key}' to artifact name '${artifactName}'`);
  }

  const retentionRaw = core.getInput('retention-days').trim();
  const retentionDays = retentionRaw ? Number(retentionRaw) : DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(`Invalid retention-days '${retentionRaw}': must be a positive integer.`);
  }

  const token = core.getInput('token') || process.env.GITHUB_TOKEN || undefined;
  if (operations.get && !token) {
    core.warning(
      'No token available (set the `token` input or GITHUB_TOKEN env); the previous timestamp cannot be retrieved.',
    );
  }

  core.debug(
    `collectInputs: rawMode='${modeRaw}' normalized='${mode}' failIfMissing=${failIfMissing} operations=${JSON.stringify(
      operations,
    )} artifactName='${artifactName}' retentionDays=${retentionDays}`,
  );
  return { mode, failIfMissing, operations, artifactName, retentionDays, token };
}

/**
 * Replaces characters that artifact names may not contain (e.g. the `/` in branch names like
 * `renovate/foo`) with `-`, so keys built from refs are always valid.
 * @param key Raw `key` input
 * @returns A valid artifact name (empty if the key was empty)
 */
export function sanitizeArtifactName(key: string): string {
  return key.replace(/["\\/:<>|*?\r\n]/g, '-');
}

/**
 * Retrieves the previous run timestamp (repository-level artifact lookup) and, if valid,
 * sets it as the `last-run` output. Validation enforces ISO 8601 pattern and parseability.
 *
 * When missing or invalid:
 *   - With `failIfMissing=false`: a warning is emitted, no output is set, action continues.
 *   - With `failIfMissing=true` : the action is marked failed (but execution of later steps
 *     in this function continues so a subsequent `set` operation in combined mode can still
 *     seed an initial timestamp for future runs).
 *
 * @param inputs Collected action inputs (failIfMissing, artifact name, token)
 * @returns The retrieved timestamp or null if not found/invalid
 */
async function getLastRun(inputs: CollectedInputs): Promise<string | null> {
  const { failIfMissing } = inputs;
  core.debug(`getLastRun: failIfMissing=${failIfMissing}`);

  // Download and validate the timestamp from artifacts
  const retrieved = await downloadTimestampWithValidation(inputs.artifactName, inputs.token);
  core.debug(`getLastRun: retrieved='${retrieved}'`);

  if (retrieved) {
    // Set action output and log success
    core.setOutput('last-run', retrieved);
    core.info(`Last run timestamp: ${retrieved}`);
    return retrieved;
  }

  // Handle missing timestamp based on failIfMissing setting
  const msg = 'No valid previous run timestamp found.';
  if (failIfMissing) {
    core.debug('getLastRun: failing due to missing timestamp');
    core.setFailed(msg);
    return null;
  }
  core.debug('getLastRun: missing timestamp but not failing');
  core.warning(
    `${msg} Treating this as the first run; future runs will use the timestamp stored by this run.`,
  );
  return null;
}

/**
 * Stores the current UTC timestamp as an artifact and exposes it as the `current-run` output.
 * If a previous timestamp was retrieved earlier in the run, the stored value is at least 1ms
 * later than it (see {@link nextTimestamp}).
 *
 * @param previous Previously retrieved timestamp (or null) used to enforce monotonicity
 * @param inputs Collected action inputs (artifact name, retention)
 */
async function setLastRun(previous: string | null, inputs: CollectedInputs): Promise<void> {
  core.debug(`setLastRun: previous='${previous}'`);

  const now = nextTimestamp(previous);

  core.debug(`setLastRun: uploading timestamp ${now}`);
  await uploadTimestamp(now, inputs.artifactName, inputs.retentionDays);
  core.setOutput('current-run', now);
  core.info(`Stored last run timestamp: ${now}`);
}

/**
 * Returns the current time as an ISO string, bumped to 1ms after `previous` when needed so the
 * stored value is always strictly greater (ISO strings sort chronologically).
 * @param previous Previously stored timestamp (or null)
 * @param nowMs Current epoch millis (injectable for tests)
 */
export function nextTimestamp(previous: string | null, nowMs: number = Date.now()): string {
  const prevMs = previous ? Date.parse(previous) : NaN;
  const ms = Number.isNaN(prevMs) ? nowMs : Math.max(nowMs, prevMs + 1);
  return new Date(ms).toISOString();
}

/**
 * Defines the operations to be performed based on the action mode
 */
interface Operations {
  get: boolean;
  set: boolean;
}

/**
 * Determines which operations to perform based on the specified mode string.
 * Recognizes canonical forms plus accepted aliases. Unknown values log a warning and default
 * to a read-only retrieval (`get`); `run` skips first-run seeding for them to avoid accidental writes.
 * @param mode The operation mode ('get', 'set', 'get-and-set', alias, or unknown)
 * @returns Operations configuration indicating which actions to take
 */
function deriveOperations(mode: string): Operations {
  core.debug(`deriveOperations: mode='${mode}'`);

  if (mode === 'get') return { get: true, set: false };
  if (mode === 'set') return { get: false, set: true };
  if (mode === 'get-and-set' || mode === 'getset' || mode === 'get_and_set')
    return { get: true, set: true };

  // Default / unknown -> treat as read-only get
  core.warning(
    `Unknown mode '${mode}'; expected 'get', 'set', or 'get-and-set'. Falling back to read-only 'get'.`,
  );
  return { get: true, set: false };
}

/**
 * Creates a fresh private directory under RUNNER_TEMP (or the OS temp dir) so artifact files
 * never land in, or collide with, the user's workspace.
 */
async function makeTempDir(): Promise<string> {
  const base = process.env['RUNNER_TEMP'] || os.tmpdir();
  return fs.mkdtemp(path.join(base, 'last-run-'));
}

/**
 * Uploads a timestamp value as an artifact to GitHub Actions.
 * Creates a temporary file with the timestamp and uploads it with the given retention.
 * Any artifact of the same name already uploaded in this workflow run (e.g. a first-run
 * seed from an earlier `get` step) is deleted first, since artifact names are immutable
 * within a run. Implements exponential backoff retry for upload failures.
 * @param value The ISO timestamp string to upload
 * @param name Artifact name
 * @param retentionDays Artifact retention in days
 */
export async function uploadTimestamp(
  value: string,
  name: string = DEFAULT_ARTIFACT_NAME,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<void> {
  core.debug(`uploadTimestamp: value='${value}'`);

  const client = new DefaultArtifactClient();
  const tempDir = await makeTempDir();
  const filePath = path.join(tempDir, FILENAME);

  // Write timestamp to temporary file
  await fs.writeFile(filePath, value, 'utf8');
  core.debug(`uploadTimestamp: wrote file ${filePath}`);

  // Remove an artifact of the same name from this run, if any, so the upload doesn't conflict
  try {
    await client.deleteArtifact(name);
    core.debug(`uploadTimestamp: deleted existing artifact '${name}' from this run`);
  } catch (error: any) {
    core.debug(`uploadTimestamp: no existing artifact deleted: ${error.message || error}`);
  }

  await retry(async (bail: (err: Error) => void, attemptNumber: number) => {
    try {
      await client.uploadArtifact(name, [filePath], tempDir, { retentionDays });
    } catch (error: any) {
      core.debug(`uploadTimestamp: attempt ${attemptNumber} failed: ${error.message}`);
      throw error;
    }
  }, RETRY_OPTIONS);
  core.debug(`uploadTimestamp: uploaded artifact '${name}'`);
}

/**
 * Regular expression to validate ISO 8601 timestamp format.
 * Matches the pattern: YYYY-MM-DDTHH:mm:ss.sssZ with optional fractional seconds
 * Examples: "2025-09-22T14:30:45Z", "2025-09-22T14:30:45.123Z"
 */
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Validates that a timestamp string conforms to ISO 8601 format and is parseable.
 * Performs both regex pattern matching and actual date parsing validation.
 * @param value The timestamp string to validate
 * @returns Validation result with success flag and optional failure reason
 */
export function validateIsoTimestamp(value: string | null | undefined): {
  ok: boolean;
  reason?: string;
} {
  if (!value) return { ok: false, reason: 'empty' };
  if (!ISO_REGEX.test(value)) return { ok: false, reason: 'pattern' };
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return { ok: false, reason: 'parse' };
  return { ok: true };
}

/**
 * Downloads and validates a timestamp from the latest repository artifact (if any).
 * Combines artifact download with format validation to ensure data integrity. Invalid or
 * unparsable values produce warnings and are treated as missing rather than failing outright.
 * @param name Artifact name
 * @param token GitHub token used for the repository-level lookup
 * @returns A valid ISO timestamp string or null if download/validation fails
 */
async function downloadTimestampWithValidation(
  name: string,
  token: string | undefined,
): Promise<string | null> {
  core.debug('downloadTimestampWithValidation: start');
  const value = await downloadTimestamp(name, token);
  core.debug(`downloadTimestampWithValidation: raw='${value}'`);
  const validation = validateIsoTimestamp(value);
  core.debug(`downloadTimestampWithValidation: validation=${JSON.stringify(validation)}`);
  if (!validation.ok) {
    if (validation.reason === 'pattern') {
      core.warning(`Invalid timestamp format in artifact: '${value}'`);
    } else if (validation.reason === 'parse') {
      core.warning(`Timestamp parse failed: '${value}'`);
    }
    return null;
  }
  core.debug('downloadTimestampWithValidation: success');
  return value!;
}

type Artifact = Awaited<
  ReturnType<ReturnType<typeof github.getOctokit>['rest']['actions']['listArtifactsForRepo']>
>['data']['artifacts'][number];

// Max pages to fetch when listing artifacts. With per_page=100 this caps the
// defensive scan at 1000 artifacts. This guards against GitHub Actions API
// eventual-consistency windows where the newest matching artifact may not
// appear on the first page during scheduling-delay backlogs (see
// github/discussion-roundup-action#138 for the analogous listWorkflowRuns bug).
const MAX_ARTIFACT_PAGES = 10;
const ARTIFACTS_PER_PAGE = 100;

/**
 * Retrieves artifacts from the repository that match the specified name.
 * Paginates across multiple pages (up to MAX_ARTIFACT_PAGES) and aggregates
 * results so the client-side sort in {@link fetchLatestRepoArtifact} has
 * enough data to reliably identify the newest artifact even if the API
 * returns mildly out-of-order results during eventual-consistency windows.
 * Implements exponential backoff retry for API failures on each page.
 * @param name The artifact name to search for (e.g., 'last-run')
 * @param token GitHub token (defaults to GITHUB_TOKEN env)
 * @returns Array of matching artifact summaries, empty if none found or no token available
 */
async function listRepoArtifactsByName(
  name: string,
  token: string | undefined = process.env.GITHUB_TOKEN,
): Promise<Artifact[]> {
  if (!token) {
    core.debug('listRepoArtifactsByName: no token available, skipping repo-level lookup');
    return [];
  }
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const per_page = ARTIFACTS_PER_PAGE;
  const all: Artifact[] = [];

  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page++) {
    core.debug(`listRepoArtifactsByName: fetching page ${page}`);
    try {
      const resp = await retry(async (bail: (err: Error) => void, attemptNumber: number) => {
        try {
          return await octokit.rest.actions.listArtifactsForRepo({
            owner,
            repo,
            per_page,
            name,
            page,
          });
        } catch (error: any) {
          core.debug(`listRepoArtifactsByName: attempt ${attemptNumber} failed: ${error.message}`);
          throw error;
        }
      }, RETRY_OPTIONS);
      const artifacts = resp.data.artifacts;
      core.debug(`listRepoArtifactsByName: page ${page} returned ${artifacts.length} artifacts`);
      all.push(...artifacts);
      // Stop once we've drained the listing (partial/empty page means no more).
      if (artifacts.length < per_page) break;
    } catch (error: any) {
      core.warning(
        `Failed to list repository artifacts after retries on page ${page}: ${error.message || error}`,
      );
      // Return whatever we've gathered so far rather than failing hard; the
      // caller will sort & validate. If this is page 1, we return [].
      return all;
    }
  }

  core.debug(`listRepoArtifactsByName: aggregated ${all.length} artifacts`);
  return all;
}

/**
 * Downloads the timestamp from the latest repository artifact.
 * Orchestrates the process of finding, downloading, and extracting the timestamp.
 * @param name Artifact name
 * @param token GitHub token (defaults to GITHUB_TOKEN env)
 * @returns The extracted timestamp string or null if any step fails
 */
export async function downloadTimestamp(
  name: string = DEFAULT_ARTIFACT_NAME,
  token: string | undefined = process.env.GITHUB_TOKEN,
): Promise<string | null> {
  try {
    const latest = await fetchLatestRepoArtifact(name, token);
    if (!latest) return null;
    const dir = await downloadArtifactArchive(latest, token);
    if (!dir) return null;
    const filePath = path.join(dir, FILENAME);
    try {
      await fs.access(filePath);
    } catch {
      core.warning(`Timestamp file not found: ${filePath}`);
      return null;
    }
    const timestamp = (await fs.readFile(filePath, 'utf8')).trim();
    return timestamp;
  } catch (err: any) {
    core.warning(`Repo-level artifact lookup failed: ${err.message || err}`);
    return null;
  }
}

/**
 * Finds the latest non-expired artifact with the specified name from the repository.
 * Sorts artifacts by creation date and returns the most recent one.
 * @param name Artifact name
 * @param token GitHub token (defaults to GITHUB_TOKEN env)
 * @returns Metadata for the latest artifact or null if none found
 */
async function fetchLatestRepoArtifact(
  name: string = DEFAULT_ARTIFACT_NAME,
  token: string | undefined = process.env.GITHUB_TOKEN,
): Promise<Artifact | null> {
  const artifacts = await listRepoArtifactsByName(name, token);
  if (!artifacts.length) {
    core.debug('fetchLatestRepoArtifact: no repo-level artifacts found');
    return null;
  }

  // Filter out expired artifacts
  const viable = artifacts.filter((a) => !a.expired);
  if (!viable.length) {
    core.debug('fetchLatestRepoArtifact: only expired artifacts found');
    return null;
  }

  // Sort by creation date and select the most recent
  viable.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  const latest = viable[viable.length - 1];
  core.debug(`fetchLatestRepoArtifact: chosen id=${latest.id} created_at=${latest.created_at}`);
  return latest;
}

/**
 * Downloads and extracts an artifact into a fresh temporary directory.
 * Implements exponential backoff retry for download failures.
 * @param latest Metadata for the artifact to download
 * @param token GitHub token (defaults to GITHUB_TOKEN env)
 * @returns Path to the extraction directory or null if download fails
 */
async function downloadArtifactArchive(
  latest: Artifact,
  token: string | undefined = process.env.GITHUB_TOKEN,
): Promise<string | null> {
  const artifact = new DefaultArtifactClient();

  if (!token) {
    core.debug('downloadArtifactArchive: missing token');
    return null;
  }

  const { owner, repo } = github.context.repo;
  const findBy = {
    token,
    workflowRunId: latest.workflow_run?.id || 0,
    repositoryOwner: owner,
    repositoryName: repo,
  };

  try {
    const downloadDir = await makeTempDir();
    const { downloadPath } = await retry(
      async (bail: (err: Error) => void, attemptNumber: number) => {
        try {
          return await artifact.downloadArtifact(latest.id, {
            path: downloadDir,
            findBy,
          });
        } catch (error: any) {
          core.debug(`downloadArtifactArchive: attempt ${attemptNumber} failed: ${error.message}`);
          throw error;
        }
      },
      RETRY_OPTIONS,
    );

    core.debug(`downloadArtifactArchive: wrote to ${downloadPath}`);
    return downloadPath ?? null;
  } catch (error: any) {
    core.warning(`Failed to download artifact archive after retries: ${error.message || error}`);
    return null;
  }
}

// Test-only exports to facilitate unit coverage of internal logic without making them part of the public API.
// These are tree-shaken away in normal action consumption since they are unused.
export const __test__ = {
  listRepoArtifactsByName,
  fetchLatestRepoArtifact,
  downloadArtifactArchive,
  validateIsoTimestamp,
  nextTimestamp,
  sanitizeArtifactName,
};
