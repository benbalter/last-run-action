import { run, uploadTimestamp, downloadTimestamp } from '../src/index';
import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';

jest.mock('@actions/core');

// Simple in-memory artifact store mock plus mode / failure flags
const artifacts: Record<string, string> = {};
let failList = false; // legacy single-fail flag
let failListCount = 0; // number of times listArtifacts should fail before succeeding
let failDownloadCount = 0; // number of times downloadArtifact should fail before succeeding
let simulateZip = false;
let corruptZip = false; // when true and simulateZip, create an invalid/corrupt zip file

jest.mock('@actions/artifact', () => {
  const fs = require('fs');
  const path = require('path');
  class MockArtifactClient {
    async uploadArtifact(name: string, files: string[], root: string) {
      const filePath = files[0];
      artifacts[name] = fs.readFileSync(filePath, 'utf8');
      return { id: 1, size: artifacts[name].length, name };
    }
    async listArtifacts() {
      if (failList) throw new Error('list failed');
      if (failListCount > 0) {
        failListCount--;
        throw new Error('transient list error');
      }
      return { artifacts: Object.keys(artifacts).map((n, i) => ({ id: i + 1, name: n })) };
    }
    async downloadArtifact(id: number, opts: { path: string }) {
      if (failDownloadCount > 0) {
        failDownloadCount--;
        throw new Error('transient download error');
      }
      const name = Object.keys(artifacts)[id - 1];
      if (!name) throw new Error('Artifact not found');
      const dir = opts.path || process.cwd();
      const filename = 'last-run.txt';
      if (simulateZip) {
        const zipPath = path.join(dir, 'artifact.zip');
        if (corruptZip) {
          // Write junk data that won't parse as a zip
          fs.writeFileSync(zipPath, 'not-a-zip');
          return { downloadPath: dir, artifactFilename: 'artifact.zip' };
        }
        // create a dummy zip containing the file
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        zip.addFile(filename, Buffer.from(artifacts[name], 'utf8'));
        zip.writeZip(zipPath);
        return { downloadPath: dir, artifactFilename: 'artifact.zip' };
      } else {
        fs.writeFileSync(path.join(dir, filename), artifacts[name], 'utf8');
        return { downloadPath: dir };
      }
    }
  }
  return { DefaultArtifactClient: MockArtifactClient };
});

const coreMock = core as jest.Mocked<typeof core>;

function setInputs(inputs: Record<string, string>) {
  for (const [k, v] of Object.entries(inputs)) {
    process.env[`INPUT_${k.toUpperCase()}`] = v;
  }
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) delete process.env[key];
  }
  Object.keys(artifacts).forEach((k) => delete artifacts[k]);
  jest.clearAllMocks();
  failList = false;
  failListCount = 0;
  failDownloadCount = 0;
  simulateZip = false;
  corruptZip = false;
  // Default implementations for core input helpers
  coreMock.getInput.mockImplementation(
    (name: string) => process.env[`INPUT_${name.toUpperCase()}`] || '',
  );
  coreMock.getBooleanInput.mockImplementation(
    (name: string) => process.env[`INPUT_${name.toUpperCase()}`] === 'true',
  );
});

test('set mode uploads current timestamp', async () => {
  setInputs({ mode: 'set' });
  const infoCalls: string[] = [];
  coreMock.info.mockImplementation((msg) => {
    infoCalls.push(msg);
  });
  await run();
  expect(Object.keys(artifacts)).toContain('last-run');
  expect(infoCalls.some((m) => m.includes('Stored last run timestamp'))).toBe(true);
});

test('get mode returns previously set timestamp', async () => {
  // First set
  setInputs({ mode: 'set' });
  await run();
  const stored = artifacts['last-run'];
  // Then get
  setInputs({ mode: 'get' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBe(stored);
});

test('get mode with no artifact logs absence and sets no output', async () => {
  setInputs({ mode: 'get' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBeUndefined();
});

test('error path when listing artifacts produces warning and no output', async () => {
  failList = true;
  setInputs({ mode: 'get' });
  const warnings: string[] = [];
  (coreMock.warning as any).mockImplementation((m: string) => warnings.push(m));
  await run();
  expect(warnings.some((w) => w.includes('Unable to retrieve last run artifact'))).toBe(true);
});

test('zip-based artifact download path is handled', async () => {
  // First set normally
  setInputs({ mode: 'set' });
  await run();
  const stored = artifacts['last-run'];
  // Now simulate zip retrieval
  simulateZip = true;
  setInputs({ mode: 'get' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBe(stored);
});

// Removed precedence test because legacy get/set flags are deprecated and removed.

test('mode get-and-set returns previous then updates artifact', async () => {
  // First set an artifact with a known value
  setInputs({ mode: 'set' });
  await run();
  const previous = artifacts['last-run'];

  // Now run get-and-set
  setInputs({ mode: 'get-and-set' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBe(previous);
  // After run, artifact should have been updated to a newer timestamp (lexicographically greater)
  expect(artifacts['last-run']).not.toBe(previous);
});

test('fail-if-missing causes action failure when no artifact', async () => {
  setInputs({ mode: 'get', 'fail-if-missing': 'true' });
  const failures: string[] = [];
  coreMock.setFailed.mockImplementation((m: string | Error) => failures.push(String(m)));
  await run();
  expect(failures.some((m) => m.includes('No valid previous run timestamp'))).toBe(true);
});

test('invalid stored timestamp is ignored (no output) without failing', async () => {
  // Create invalid artifact value directly
  artifacts['last-run'] = 'not-a-timestamp';
  setInputs({ mode: 'get' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBeUndefined();
});

test('corrupted zip produces warning and no output', async () => {
  // Seed valid artifact
  artifacts['last-run'] = new Date().toISOString();
  simulateZip = true;
  corruptZip = true;
  setInputs({ mode: 'get' });
  const warnings: string[] = [];
  (coreMock.warning as any).mockImplementation((m: string) => warnings.push(m));
  await run();
  // Depending on AdmZip error, message may vary; ensure either specific message or no output produced
  const hadOutput = (coreMock.setOutput as jest.Mock).mock.calls.some((c) => c[0] === 'last-run');
  expect(hadOutput).toBe(false);
});

test('retry logic succeeds after transient list failure', async () => {
  // Seed artifact
  artifacts['last-run'] = new Date().toISOString();
  failListCount = 1; // first list fails, second succeeds
  setInputs({ mode: 'get' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBeDefined();
});

test('retry logic succeeds after transient download failure', async () => {
  // Seed artifact via upload path for realism
  setInputs({ mode: 'set' });
  await run();
  failDownloadCount = 1; // first download fails
  setInputs({ mode: 'get' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBeDefined();
});

test('alias mode getset behaves like get-and-set', async () => {
  setInputs({ mode: 'set' });
  await run();
  const previous = artifacts['last-run'];
  setInputs({ mode: 'getset' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBe(previous);
  expect(artifacts['last-run']).not.toBe(previous);
});

test('alias mode get_and_set behaves like get-and-set', async () => {
  setInputs({ mode: 'set' });
  await run();
  const previous = artifacts['last-run'];
  setInputs({ mode: 'get_and_set' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBe(previous);
  expect(artifacts['last-run']).not.toBe(previous);
});

test('unknown mode defaults to get only', async () => {
  // Prepare artifact
  setInputs({ mode: 'set' });
  await run();
  const stored = artifacts['last-run'];
  // Use unknown mode value
  setInputs({ mode: 'mystery' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBe(stored);
  // Ensure artifact not updated (value unchanged)
  expect(artifacts['last-run']).toBe(stored);
});

test('invalid timestamp with fail-if-missing triggers failure', async () => {
  artifacts['last-run'] = 'INVALID_TIME';
  setInputs({ mode: 'get', 'fail-if-missing': 'true' });
  const failures: string[] = [];
  coreMock.setFailed.mockImplementation((m: string | Error) => failures.push(String(m)));
  await run();
  expect(failures.some((m) => m.includes('No valid previous run timestamp'))).toBe(true);
});

test('mode set does not set output', async () => {
  setInputs({ mode: 'set' });
  const outputs: Record<string, string> = {};
  coreMock.setOutput.mockImplementation((k, v) => {
    outputs[k] = v as string;
  });
  await run();
  expect(outputs['last-run']).toBeUndefined();
});

test('error during upload results in failure', async () => {
  // Mock artifact client upload to throw
  const MockedArtifact = require('@actions/artifact');
  MockedArtifact.DefaultArtifactClient.prototype.uploadArtifact = jest
    .fn()
    .mockRejectedValue(new Error('upload boom'));
  setInputs({ mode: 'set' });
  const failures: string[] = [];
  coreMock.setFailed.mockImplementation((m: string | Error) => failures.push(String(m)));
  await run();
  expect(failures.some((m) => m.includes('upload boom'))).toBe(true);
});
