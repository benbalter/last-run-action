import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

const ARTIFACT_NAME = 'last-run';
const FILENAME = 'last-run.txt';

export async function run(): Promise<void> {
  try {
    const { mode, failIfMissing, operations } = collectInputs();
    core.debug(`Effective operations: ${JSON.stringify(operations)} (mode='${mode}')`);
    let retrieved: string | null = null;
    if (operations.get) {
      core.startGroup('Retrieve last run timestamp');
      retrieved = await maybeGetLastRun(operations.get, failIfMissing);
      core.endGroup();
    }
    if (operations.set) {
      core.startGroup('Store current timestamp');
      await maybeSetLastRun(operations.set, retrieved);
      core.endGroup();
    }
  } catch (error: any) {
    core.setFailed(error.message || String(error));
  }
}

interface CollectedInputs {
  mode: string;
  failIfMissing: boolean;
  operations: Operations;
}

function collectInputs(): CollectedInputs {
  const modeRaw = core.getInput('mode').trim();
  const mode = (modeRaw || 'get').toLowerCase();
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
 * Conditionally retrieves the previous run timestamp, emitting it as an output or
 * failing the action if required and not found.
 */
async function maybeGetLastRun(doGet: boolean, failIfMissing: boolean): Promise<string | null> {
  core.debug(`maybeGetLastRun: doGet=${doGet} failIfMissing=${failIfMissing}`);
  if (!doGet) return null;
  const retrieved = await downloadTimestampWithValidation();
  core.debug(`maybeGetLastRun: retrieved='${retrieved}'`);
  if (retrieved) {
    core.setOutput('last-run', retrieved);
    core.info(`Last run timestamp: ${retrieved}`);
    return retrieved;
  }
  const msg = 'No valid previous run timestamp found.';
  if (failIfMissing) {
    core.debug('maybeGetLastRun: failing due to missing timestamp');
    core.setFailed(msg);
    return null;
  }
  core.debug('maybeGetLastRun: missing timestamp but not failing');
  core.warning(msg);
  return null;
}

async function maybeSetLastRun(doSet: boolean, previous: string | null): Promise<void> {
  core.debug(`maybeSetLastRun: doSet=${doSet} previous='${previous}'`);
  if (!doSet) return;
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
      core.debug(`maybeSetLastRun: waited ${safeguard} iterations to ensure monotonic timestamp`);
    }
  }
  core.debug(`maybeSetLastRun: uploading timestamp ${now}`);
  await uploadTimestamp(now);
  core.info(`Stored last run timestamp: ${now}`);
  // Design choice: output only set during get / get-and-set retrieval.
}

interface Operations {
  get: boolean;
  set: boolean;
}
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

export async function uploadTimestamp(value: string): Promise<void> {
  core.debug(`uploadTimestamp: value='${value}'`);
  const client = new DefaultArtifactClient();
  const tempDir = process.env['RUNNER_TEMP'] || process.cwd();
  const filePath = path.join(tempDir, FILENAME);
  await fs.writeFile(filePath, value, 'utf8');
  core.debug(`uploadTimestamp: wrote file ${filePath}`);
  await client.uploadArtifact(ARTIFACT_NAME, [filePath], tempDir, { retentionDays: 90 });
  core.debug(`uploadTimestamp: uploaded artifact '${ARTIFACT_NAME}'`);
}

// Removed per-run artifact retrieval logic; repository-level lookup is now primary.

// Validate ISO 8601 basic (YYYY-MM-DDTHH:mm:ss.sssZ) – allow variable precision
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

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

interface RepoArtifactSummary {
  id: number;
  name: string;
  created_at: string;
  expired: boolean;
  archive_download_url: string;
}

async function listAllRepoArtifactsByName(name: string): Promise<RepoArtifactSummary[]> {
  const token = process.env['GITHUB_TOKEN'] || process.env['ACTIONS_RUNTIME_TOKEN'];
  if (!token) {
    core.debug('listAllRepoArtifactsByName: no token available, skipping repo-level lookup');
    return [];
  }
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const per_page = 100;
  let page = 1;
  const matches: RepoArtifactSummary[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    core.debug(`listAllRepoArtifactsByName: fetching page ${page}`);
    const resp = await octokit.rest.actions.listArtifactsForRepo({ owner, repo, per_page, page });
    const artifacts = resp.data.artifacts as any[];
    for (const a of artifacts) {
      if (a.name === name) {
        matches.push({
          id: a.id,
          name: a.name,
          created_at: a.created_at,
          expired: !!a.expired,
          archive_download_url: a.archive_download_url,
        });
      }
    }
    if (artifacts.length < per_page) break; // last page
    page++;
    if (page > 10) {
      // safety cap (1000 artifacts)
      core.debug('listAllRepoArtifactsByName: reached page cap, stopping');
      break;
    }
  }
  core.debug(`listAllRepoArtifactsByName: total matches=${matches.length}`);
  return matches;
}

export async function downloadTimestamp(): Promise<string | null> {
  try {
    const latest = await fetchLatestRepoArtifact();
    if (!latest) return null;
    const zipPath = await downloadArtifactArchive(latest);
    if (!zipPath) return null;
    return await extractTimestampFromZip(zipPath);
  } catch (err: any) {
    core.warning(`Repo-level artifact lookup failed: ${err.message || err}`);
    return null;
  }
}

interface LatestArtifactMeta {
  id: number;
  created_at: string;
  archive_download_url: string;
}

async function fetchLatestRepoArtifact(): Promise<LatestArtifactMeta | null> {
  const artifacts = await listAllRepoArtifactsByName(ARTIFACT_NAME);
  if (!artifacts.length) {
    core.debug('fetchLatestRepoArtifact: no repo-level artifacts found');
    return null;
  }
  const viable = artifacts.filter((a) => !a.expired);
  if (!viable.length) {
    core.debug('fetchLatestRepoArtifact: only expired artifacts found');
    return null;
  }
  viable.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const latest = viable[viable.length - 1];
  core.debug(`fetchLatestRepoArtifact: chosen id=${latest.id} created_at=${latest.created_at}`);
  return latest;
}

async function downloadArtifactArchive(latest: LatestArtifactMeta): Promise<string | null> {
  const token = process.env['GITHUB_TOKEN'] || process.env['ACTIONS_RUNTIME_TOKEN'];
  if (!token) {
    core.debug('downloadArtifactArchive: missing token');
    return null;
  }
  const octokit = github.getOctokit(token);
  const resp = await octokit.request(latest.archive_download_url, {
    headers: { Accept: 'application/zip' },
  });
  const tempDir = process.env['RUNNER_TEMP'] || process.cwd();
  const zipPath = path.join(tempDir, `repo-artifact-${latest.id}.zip`);
  await fs.writeFile(zipPath, Buffer.from(resp.data as ArrayBuffer));
  core.debug(`downloadArtifactArchive: wrote ${zipPath}`);
  return zipPath;
}

async function extractTimestampFromZip(zipPath: string): Promise<string | null> {
  try {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry(FILENAME);
    if (!entry) {
      core.debug('extractTimestampFromZip: entry not found');
      return null;
    }
    const content = zip.readAsText(entry).trim();
    core.debug('extractTimestampFromZip: extracted timestamp');
    return content;
  } catch (err: any) {
    core.warning(`Failed to extract zip: ${err.message || err}`);
    return null;
  }
}

// Removed custom retryAsync in favor of async-retry for clearer semantics and backoff handling.

// Auto-execute only when run directly by Node (GitHub Actions runtime)
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  run();
}
