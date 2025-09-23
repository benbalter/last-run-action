// Import required dependencies for GitHub Actions integration, artifact management, and file operations
import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import * as path from 'path';
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';

// Constants for artifact management
const ARTIFACT_NAME = 'last-run';
const FILENAME = 'last-run.txt';

/**
 * Main entry point for the GitHub Action.
 *
 * Supported modes (input: `mode`):
 *   - `get`          : Retrieve previously stored timestamp (if any) and expose it as `last-run` output.
 *   - `set`          : Store current timestamp (no output produced).
 *   - `get-and-set`  : Retrieve previous timestamp (output) then store a strictly newer timestamp.
 *   - Aliases `getset`, `get_and_set` behave like `get-and-set`.
 *   - Any unknown value quietly defaults to `get`.
 *
 * Failure semantics:
 *   When `fail-if-missing: true` and a valid prior timestamp cannot be retrieved, the action is
 *   marked as failed (core.setFailed). If the selected mode also performs `set` (e.g. `get-and-set`),
 *   the new timestamp upload STILL proceeds. This design ensures subsequent runs have a baseline
 *   timestamp even if the first retrieval attempt failed.
 *
 * Monotonicity:
 *   In combined `get-and-set` modes a loop waits (at microsecond resolution governed by Date.now())
 *   until the newly generated ISO timestamp string is strictly greater than the previous to avoid
 *   duplicate values in extremely fast consecutive invocations.
 */
export async function run(): Promise<void> {
  try {
    // Parse action inputs to determine what operations to perform
    const { mode, failIfMissing, operations } = collectInputs();
    core.debug(`Effective operations: ${JSON.stringify(operations)} (mode='${mode}')`);

    let retrieved: string | null = null;

    // Retrieve previous timestamp if requested
    if (operations.get) {
      core.startGroup('Retrieve last run timestamp');
      retrieved = await getLastRun(failIfMissing);
      core.endGroup();
    }

    // Store current timestamp if requested
    if (operations.set) {
      core.startGroup('Store current timestamp');
      await setLastRun(retrieved);
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

  core.debug(
    `collectInputs: rawMode='${modeRaw}' normalized='${mode}' failIfMissing=${failIfMissing} operations=${JSON.stringify(
      operations,
    )}`,
  );
  return { mode, failIfMissing, operations };
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
 * @param failIfMissing Whether to fail the action if no valid timestamp is found
 * @returns The retrieved timestamp or null if not found/invalid
 */
async function getLastRun(failIfMissing: boolean): Promise<string | null> {
  core.debug(`getLastRun: failIfMissing=${failIfMissing}`);

  // Download and validate the timestamp from artifacts
  const retrieved = await downloadTimestampWithValidation();
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
  core.warning(msg);
  return null;
}

/**
 * Stores the current UTC timestamp (`Date().toISOString()`) as an artifact named `last-run`.
 * If a previous timestamp was retrieved earlier in the run, guarantees the newly stored value
 * is lexicographically (and chronologically) greater by regenerating until strictly larger.
 *
 * Output note: By design, `set`-only flows do not emit an output; workflows that need the
 * previous value should use `get` first or the combined `get-and-set` mode.
 *
 * @param previous Previously retrieved timestamp (or null) used to enforce monotonicity
 */
async function setLastRun(previous: string | null): Promise<void> {
  core.debug(`setLastRun: previous='${previous}'`);

  let now = new Date().toISOString();

  // Ensure monotonic increase when previous exists (avoid identical timestamps on fast successive sets)
  if (previous) {
    // Loop until we get a strictly greater ISO string (lexicographically greater since format is sortable)
    let safeguard = 0;
    while (now <= previous && safeguard < 1000) {
      now = new Date().toISOString();
      safeguard++;
    }
    if (safeguard > 0) {
      core.debug(`setLastRun: waited ${safeguard} iterations to ensure monotonic timestamp`);
    }
  }

  core.debug(`setLastRun: uploading timestamp ${now}`);
  await uploadTimestamp(now);
  core.info(`Stored last run timestamp: ${now}`);
  // Design choice: output only set during get / get-and-set retrieval.
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
 * Recognizes canonical forms plus accepted aliases. Unknown values default to a safe
 * read-only retrieval (`get`). This conservative default avoids accidental writes.
 * @param mode The operation mode ('get', 'set', 'get-and-set', alias, or unknown)
 * @returns Operations configuration indicating which actions to take
 */
function deriveOperations(mode: string): Operations {
  core.debug(`deriveOperations: mode='${mode}'`);

  if (mode === 'get') return { get: true, set: false };
  if (mode === 'set') return { get: false, set: true };
  if (mode === 'get-and-set' || mode === 'getset' || mode === 'get_and_set')
    return { get: true, set: true };

  // Default / unknown -> treat as get
  core.debug('deriveOperations: defaulting to get');
  return { get: true, set: false };
}

/**
 * Uploads a timestamp value as an artifact to GitHub Actions.
 * Creates a temporary file with the timestamp and uploads it with 90-day retention.
 * @param value The ISO timestamp string to upload
 */
export async function uploadTimestamp(value: string): Promise<void> {
  core.debug(`uploadTimestamp: value='${value}'`);

  const client = new DefaultArtifactClient();
  const tempDir = process.env['RUNNER_TEMP'] || process.cwd();
  const filePath = path.join(tempDir, FILENAME);

  // Write timestamp to temporary file
  await fs.writeFile(filePath, value, 'utf8');
  core.debug(`uploadTimestamp: wrote file ${filePath}`);

  // Upload the file as an artifact with 90-day retention
  await client.uploadArtifact(ARTIFACT_NAME, [filePath], tempDir, { retentionDays: 90 });
  core.debug(`uploadTimestamp: uploaded artifact '${ARTIFACT_NAME}'`);
}

// NOTE: Prior implementations attempted a per-run artifact short-circuit. That logic was
// removed: repository-level lookup alone provides simpler, deterministic behavior and the
// necessary cross-run persistence without extra branches.

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
 * @returns A valid ISO timestamp string or null if download/validation fails
 */
async function downloadTimestampWithValidation(): Promise<string | null> {
  core.debug('downloadTimestampWithValidation: start');
  core.startGroup('Download & validate timestamp');
  const value = await downloadTimestamp();
  core.debug(`downloadTimestampWithValidation: raw='${value}'`);
  const validation = validateIsoTimestamp(value);
  core.debug(`downloadTimestampWithValidation: validation=${JSON.stringify(validation)}`);
  if (!validation.ok) {
    if (validation.reason === 'pattern') {
      core.warning(`Invalid timestamp format in artifact: '${value}'`);
    } else if (validation.reason === 'parse') {
      core.warning(`Timestamp parse failed: '${value}'`);
    }
    core.endGroup();
    return null;
  }
  core.debug('downloadTimestampWithValidation: success');
  core.endGroup();
  return value!;
}

type Artifact =
  RestEndpointMethodTypes['actions']['listArtifactsForRepo']['response']['data']['artifacts'][number];

/**
 * Retrieves artifacts from the repository that match the specified name.
 * Returns only the first page of results since the name filter is applied server-side.
 * @param name The artifact name to search for (e.g., 'last-run')
 * @returns Array of matching artifact summaries, empty if none found or no token available
 */
async function listRepoArtifactsByName(name: string): Promise<Artifact[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    core.debug('listRepoArtifactsByName: no token available, skipping repo-level lookup');
    return [];
  }
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const per_page = 100;

  core.debug('listRepoArtifactsByName: fetching first page');
  const resp = await octokit.rest.actions.listArtifactsForRepo({ owner, repo, per_page, name });
  const artifacts = resp.data.artifacts;
  core.debug(`listRepoArtifactsByName: found ${artifacts.length} artifacts`);
  return artifacts;
}

/**
 * Downloads the timestamp from the latest repository artifact.
 * Orchestrates the process of finding, downloading, and extracting the timestamp.
 * @returns The extracted timestamp string or null if any step fails
 */
export async function downloadTimestamp(): Promise<string | null> {
  try {
    const latest = await fetchLatestRepoArtifact();
    if (!latest) return null;
    const dir = await downloadArtifactArchive(latest);
    if (!dir) return null;
    const path = `${dir}/${FILENAME}`;
    if (!(await fs.stat(path))) {
      core.warning(`Timestamp file not found: ${path}`);
      return null;
    }
    const timestamp = await fs.readFile(path, 'utf8');
    return timestamp;
  } catch (err: any) {
    core.warning(`Repo-level artifact lookup failed: ${err.message || err}`);
    return null;
  }
}

/**
 * Finds the latest non-expired artifact with the specified name from the repository.
 * Sorts artifacts by creation date and returns the most recent one.
 * @returns Metadata for the latest artifact or null if none found
 */
async function fetchLatestRepoArtifact(): Promise<Artifact | null> {
  const artifacts = await listRepoArtifactsByName(ARTIFACT_NAME);
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
 * Downloads an artifact archive from GitHub and saves it to a temporary file.
 * Uses the GitHub REST API to download the artifact as a ZIP file.
 * @param latest Metadata for the artifact to download
 * @returns Path to the downloaded ZIP file or null if download fails
 */
async function downloadArtifactArchive(latest: Artifact): Promise<string | null | undefined> {
  const artifact = new DefaultArtifactClient();
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    core.debug('downloadArtifactArchive: missing token');
    return null;
  }

  const { owner, repo } = github.context.repo;
  const findBy = {
    token: process.env['GITHUB_TOKEN'] || '',
    workflowRunId: latest.workflow_run?.id || 0,
    repositoryOwner: owner,
    repositoryName: repo,
  };

  const { downloadPath } = await artifact.downloadArtifact(latest.id, {
    findBy,
  });

  core.debug(`downloadArtifactArchive: wrote to ${downloadPath}`);
  return downloadPath;
}

// Auto-execute only when run directly by Node (GitHub Actions runtime)
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  run();
}

// Test-only exports to facilitate unit coverage of internal logic without making them part of the public API.
// These are tree-shaken away in normal action consumption since they are unused.
export const __test__ = {
  listRepoArtifactsByName,
  fetchLatestRepoArtifact,
  downloadArtifactArchive,
  validateIsoTimestamp,
};
