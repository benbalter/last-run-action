import {
  extractArtifactContent,
  extractFromZip,
  findArtifact,
  downloadArtifactPayload,
} from '../src/index';
import { DefaultArtifactClient } from '@actions/artifact';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mocks for artifact client and file system
jest.mock('@actions/artifact');

const ARTIFACT_NAME = 'last-run';
const FILENAME = 'last-run.txt';

describe('helper function unit tests', () => {
  let tempDir: string;
  let client: any;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), 'tmp-test');
    await fs.mkdir(tempDir, { recursive: true });
    // Clean up any files from previous runs
    try {
      await fs.rm(path.join(tempDir, FILENAME));
    } catch {}
    try {
      await fs.rm(path.join(tempDir, 'artifact.zip'));
    } catch {}
    client = new (require('@actions/artifact').DefaultArtifactClient)();
  });

  afterAll(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('extractArtifactContent reads plain file', async () => {
    const testContent = '2025-09-20T12:34:56.789Z';
    await fs.writeFile(path.join(tempDir, FILENAME), testContent, 'utf8');
    const result = await extractArtifactContent({ downloadPath: tempDir });
    expect(result).toBe(testContent);
  });

  test('extractArtifactContent reads from zip', async () => {
    const AdmZip = require('adm-zip');
    const testContent = '2025-09-20T12:34:56.789Z';
    const zip = new AdmZip();
    zip.addFile(FILENAME, Buffer.from(testContent, 'utf8'));
    const zipPath = path.join(tempDir, 'artifact.zip');
    zip.writeZip(zipPath);
    const result = await extractArtifactContent({
      downloadPath: tempDir,
      artifactFilename: 'artifact.zip',
    });
    expect(result).toBe(testContent);
  });

  test('extractArtifactContent returns null for missing file/zip', async () => {
    const result = await extractArtifactContent({ downloadPath: tempDir });
    expect(result).toBeNull();
  });

  test('extractFromZip returns null for missing entry', async () => {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.writeZip(path.join(tempDir, 'artifact.zip'));
    const result = await extractFromZip(tempDir, 'artifact.zip');
    expect(result).toBeNull();
  });

  test('findArtifact returns correct artifact', async () => {
    // Mock listArtifacts to return a known artifact
    client.listArtifacts = jest.fn().mockResolvedValue({
      artifacts: [
        { id: 42, name: ARTIFACT_NAME },
        { id: 99, name: 'other' },
      ],
    });
    const found = await findArtifact(client);
    expect(found).toEqual({ id: 42, name: ARTIFACT_NAME });
  });

  test('findArtifact returns undefined if not found', async () => {
    client.listArtifacts = jest.fn().mockResolvedValue({ artifacts: [{ id: 1, name: 'foo' }] });
    const found = await findArtifact(client);
    expect(found).toBeUndefined();
  });

  test('downloadArtifactPayload calls client.downloadArtifact', async () => {
    client.downloadArtifact = jest.fn().mockResolvedValue({ downloadPath: tempDir });
    const result = await downloadArtifactPayload(client, 123);
    expect(result).toEqual({ downloadPath: tempDir });
    expect(client.downloadArtifact).toHaveBeenCalledWith(123, expect.any(Object));
  });
});
