import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import { promises as fs } from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const retry = require('async-retry');

const ARTIFACT_NAME = 'last-run';
const FILENAME = 'last-run.txt';

export async function run(): Promise<void> {
  try {
    const { mode, failIfMissing, operations } = collectInputs();
    core.debug(`Effective operations: ${JSON.stringify(operations)} (mode='${mode}')`);
    if (operations.get) {
      core.startGroup('Retrieve last run timestamp');
      await maybeGetLastRun(operations.get, failIfMissing);
      core.endGroup();
    }
    if (operations.set) {
      core.startGroup('Store current timestamp');
      await maybeSetLastRun(operations.set);
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
async function maybeGetLastRun(doGet: boolean, failIfMissing: boolean): Promise<void> {
  core.debug(`maybeGetLastRun: doGet=${doGet} failIfMissing=${failIfMissing}`);
  if (!doGet) return;
  const retrieved = await downloadTimestampWithValidation();
  core.debug(`maybeGetLastRun: retrieved='${retrieved}'`);
  if (retrieved) {
    core.setOutput('last-run', retrieved);
    core.info(`Last run timestamp: ${retrieved}`);
    return;
  }
  const msg = 'No valid previous run timestamp found.';
  if (failIfMissing) {
    core.debug('maybeGetLastRun: failing due to missing timestamp');
    core.setFailed(msg);
    return;
  }
  core.debug('maybeGetLastRun: missing timestamp but not failing');
  core.warning(msg);
}

async function maybeSetLastRun(doSet: boolean): Promise<void> {
  core.debug(`maybeSetLastRun: doSet=${doSet}`);
  if (!doSet) return;
  const now = new Date().toISOString();
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

export async function downloadTimestamp(): Promise<string | null> {
  core.debug('downloadTimestamp: start');
  try {
    const client = new DefaultArtifactClient();
    const found = await findArtifact(client);
    core.debug(`downloadTimestamp: artifactFound=${!!found}`);
    if (!found) return null;
    core.startGroup('Download last-run artifact');
    const downloadResponse = await downloadArtifactPayload(client, found.id);
    core.debug('downloadTimestamp: downloaded artifact, extracting');
    const result = await extractArtifactContent(downloadResponse);
    core.endGroup();
    return result;
  } catch (e: any) {
    core.warning(`Unable to retrieve last run artifact: ${e.message || e}`);
    core.debug('downloadTimestamp: error encountered, returning null');
    return null;
  }
}

interface ListedArtifact {
  id: number;
  name: string;
}

export async function findArtifact(
  client: DefaultArtifactClient,
): Promise<ListedArtifact | undefined> {
  core.debug('findArtifact: listing artifacts with retry');
  const list = await retry(
    async (bail: (e: Error) => void, attempt: number) => {
      try {
        return await client.listArtifacts();
      } catch (err: any) {
        core.debug(`listArtifacts attempt ${attempt} failed: ${err.message || err}`);
        throw err;
      }
    },
    {
      retries: 2,
      factor: 2,
      minTimeout: 250,
      maxTimeout: 1000,
      randomize: false,
    },
  );
  core.debug(`findArtifact: totalArtifacts=${list.artifacts.length}`);
  return list.artifacts.find((a: any) => a.name === ARTIFACT_NAME);
}

export async function downloadArtifactPayload(
  client: DefaultArtifactClient,
  artifactId: number,
): Promise<any> {
  core.debug(`downloadArtifactPayload: artifactId=${artifactId}`);
  return retry(
    async (bail: (e: Error) => void, attempt: number) => {
      try {
        return await client.downloadArtifact(artifactId, { path: process.cwd() } as any);
      } catch (err: any) {
        core.debug(`downloadArtifact attempt ${attempt} failed: ${err.message || err}`);
        throw err;
      }
    },
    {
      retries: 2,
      factor: 2,
      minTimeout: 400,
      maxTimeout: 1500,
      randomize: false,
    },
  );
}

export async function extractArtifactContent(downloadResponse: any): Promise<string | null> {
  core.debug(
    `extractArtifactContent: downloadPath='${downloadResponse.downloadPath}' zip='${downloadResponse.artifactFilename}'`,
  );
  const fileDir = downloadResponse.downloadPath || process.cwd();
  const targetPath = path.join(fileDir, FILENAME);
  try {
    await fs.access(targetPath);
    core.debug('extractArtifactContent: found plain file');
  } catch {
    if (downloadResponse.artifactFilename) {
      core.debug('extractArtifactContent: attempting zip extraction');
      return extractFromZip(fileDir, downloadResponse.artifactFilename as string);
    }
    core.debug('extractArtifactContent: no file or zip present');
    return null;
  }
  const content = await fs.readFile(targetPath, 'utf8');
  core.debug('extractArtifactContent: file read complete');
  return content.trim();
}

export async function extractFromZip(dir: string, zipName: string): Promise<string | null> {
  core.debug(`extractFromZip: dir='${dir}' zip='${zipName}'`);
  const zipPath = path.join(dir, zipName);
  try {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry(FILENAME);
    if (!entry) return null;
    core.debug('extractFromZip: entry found');
    return zip.readAsText(entry).trim();
  } catch (zipErr: any) {
    core.warning(`Failed to extract zip: ${zipErr.message || zipErr}`);
    core.debug('extractFromZip: extraction failed');
    return null;
  }
}

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

// Removed custom retryAsync in favor of async-retry for clearer semantics and backoff handling.

// Auto-execute only when run directly by Node (GitHub Actions runtime)
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  run();
}
