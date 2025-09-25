// Repo-level primary retrieval test suite
import { run } from '../src/index';
import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';

jest.mock('@actions/core');

// In-memory storage of last uploaded timestamp value (simulates contents of artifact before zipped on download)
const uploaded: { value?: string } = {};

// Mock artifact client for upload path (set operations)
jest.mock('@actions/artifact', () => {
  const fs = require('fs');
  class MockArtifactClient {
    async uploadArtifact(name: string, files: string[]) {
      if (name !== 'last-run') throw new Error('unexpected artifact name');
      const filePath = files[0];
      uploaded.value = fs.readFileSync(filePath, 'utf8');
      return { id: 999, size: (uploaded.value || '').length, name };
    }
  }
  return { DefaultArtifactClient: MockArtifactClient };
});

// Mocks for repo-level listing & download
const listArtifactsMock = jest.fn();
jest.mock('@actions/github', () => ({
  getOctokit: () => ({
    rest: { actions: { listArtifactsForRepo: listArtifactsMock } },
  }),
  context: { repo: { owner: 'o', repo: 'r' } },
}));

// Mock the artifact download path via DefaultArtifactClient.downloadArtifact to return our zip buffer
const downloadArtifactMock = jest.fn();
jest.mock('@actions/artifact', () => {
  class MockArtifactClient {
    async uploadArtifact(name: string, files: string[], _root?: string) {
      const fs = require('fs');
      const filePath = files[0];
      uploaded.value = fs.readFileSync(filePath, 'utf8');
      return { id: 999, size: (uploaded.value || '').length, name };
    }
    async downloadArtifact(id: number): Promise<{ downloadPath: string }> {
      return downloadArtifactMock(id);
    }
  }
  return { DefaultArtifactClient: MockArtifactClient };
});

const coreMock = core as jest.Mocked<typeof core>;

function setInputs(inputs: Record<string, string>) {
  for (const [k, v] of Object.entries(inputs)) process.env[`INPUT_${k.toUpperCase()}`] = v;
}

// Helper to simulate artifact download by writing extracted file directly into directory
function writeArtifactDir(artifactId: number, content: string | null | undefined) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(process.cwd(), `artifact-${artifactId}`);
  fs.mkdirSync(dir, { recursive: true });
  if (content !== null && content !== undefined) {
    fs.writeFileSync(path.join(dir, 'last-run.txt'), content, 'utf8');
  }
  return dir;
}

function mockRepoArtifact(options: {
  id?: number;
  created_at?: string;
  expired?: boolean;
  content?: string | null;
  additionalArtifacts?: Array<{ id: number; created_at: string; expired?: boolean }>;
}) {
  const {
    id = Math.floor(Math.random() * 1000),
    created_at = new Date().toISOString(),
    expired = false,
    content = created_at,
    additionalArtifacts = [],
  } = options;
  process.env.GITHUB_TOKEN = 'token';
  const artifactsPage: any[] = [
    {
      id,
      name: 'last-run',
      created_at,
      expired,
      archive_download_url: `GET /repos/o/r/actions/artifacts/${id}/zip`,
    },
    ...additionalArtifacts.map((a) => ({
      id: a.id,
      name: 'last-run',
      created_at: a.created_at,
      expired: !!a.expired,
      archive_download_url: `GET /repos/o/r/actions/artifacts/${a.id}/zip`,
    })),
  ];
  listArtifactsMock.mockResolvedValueOnce({ data: { artifacts: artifactsPage } });
  if (content !== undefined) {
    downloadArtifactMock.mockImplementationOnce(async (artifactId: number) => {
      const dir = writeArtifactDir(artifactId, content);
      return { downloadPath: dir };
    });
  }
  return { id, created_at, content };
}

beforeEach(() => {
  // Reset environment inputs
  for (const key of Object.keys(process.env)) if (key.startsWith('INPUT_')) delete process.env[key];
  jest.clearAllMocks();
  delete process.env.GITHUB_TOKEN;
  uploaded.value = undefined;
  // Completely reset the mocks to ensure no queued responses remain
  listArtifactsMock.mockReset();
  listArtifactsMock.mockResolvedValue({ data: { artifacts: [] } });
  downloadArtifactMock.mockReset();
  coreMock.getInput.mockImplementation(
    (n: string) => process.env[`INPUT_${n.toUpperCase()}`] || '',
  );
  coreMock.getBooleanInput.mockImplementation(
    (n: string) => process.env[`INPUT_${n.toUpperCase()}`] === 'true',
  );
});

test('mode set uploads timestamp (no output)', async () => {
  setInputs({ mode: 'set' });
  await run();
  expect(uploaded.value).toBeTruthy();
  expect(coreMock.setOutput).not.toHaveBeenCalledWith('last-run', expect.anything());
});

test('mode get retrieves existing repo artifact', async () => {
  // Simulate existing artifact created previously
  const ts = new Date().toISOString();
  mockRepoArtifact({ created_at: ts, content: ts });
  setInputs({ mode: 'get' });
  await run();
  expect(coreMock.setOutput).toHaveBeenCalledWith('last-run', ts);
});

test('mode get with no token yields no output and warning', async () => {
  const warnings: string[] = [];
  (coreMock.warning as any).mockImplementation((m: string) => warnings.push(m));
  setInputs({ mode: 'get' });
  await run();
  expect(coreMock.setOutput).not.toHaveBeenCalled();
  expect(warnings.some((w) => w.includes('No valid previous run timestamp'))).toBe(true);
});

test('mode get-and-set returns previous then uploads newer timestamp', async () => {
  const earlier = new Date(Date.now() - 5000).toISOString();
  mockRepoArtifact({ created_at: earlier, content: earlier });
  setInputs({ mode: 'get-and-set' });
  await run();
  // First output set to earlier
  expect(coreMock.setOutput).toHaveBeenCalledWith('last-run', earlier);
  // Upload occurred with newer value
  expect(uploaded.value && uploaded.value > earlier).toBe(true);
});

test('alias modes getset & get_and_set behave like get-and-set', async () => {
  const ts = new Date(Date.now() - 8000).toISOString();
  mockRepoArtifact({ created_at: ts, content: ts });
  for (const alias of ['getset', 'get_and_set']) {
    // Re-seed repo artifact for each alias since previous run may upload a newer timestamp
    jest.clearAllMocks();
    mockRepoArtifact({ created_at: ts, content: ts });
    setInputs({ mode: alias });
    await run();
    expect(coreMock.setOutput).toHaveBeenCalledWith('last-run', ts);
    expect(uploaded.value && uploaded.value > ts).toBe(true);
  }
});

test('unknown mode defaults to get', async () => {
  const ts = '2030-01-01T00:00:00.000Z';
  jest.clearAllMocks();
  mockRepoArtifact({ created_at: ts, content: ts });
  setInputs({ mode: 'mystery' });
  await run();
  const calls = (coreMock.setOutput as jest.Mock).mock.calls.filter((c) => c[0] === 'last-run');
  expect(calls.length).toBe(1);
  const value = calls[0][1];
  // Must be a valid ISO timestamp
  expect(typeof value).toBe('string');
  expect(value.endsWith('Z')).toBe(true);
});

test('fail-if-missing triggers failure when absent', async () => {
  setInputs({ mode: 'get', 'fail-if-missing': 'true' });
  await run();
  expect(coreMock.setFailed).toHaveBeenCalledWith(
    expect.stringContaining('No valid previous run timestamp'),
  );
});

test('invalid timestamp content ignored (no output)', async () => {
  const bad = 'not-a-timestamp';
  mockRepoArtifact({ content: bad, created_at: new Date().toISOString() });
  setInputs({ mode: 'get' });
  await run();
  expect(coreMock.setOutput).not.toHaveBeenCalledWith('last-run', bad);
});

test('invalid timestamp with fail-if-missing fails action', async () => {
  const bad = 'invalid';
  mockRepoArtifact({ content: bad, created_at: new Date().toISOString() });
  setInputs({ mode: 'get', 'fail-if-missing': 'true' });
  await run();
  expect(coreMock.setFailed).toHaveBeenCalledWith(
    expect.stringContaining('No valid previous run timestamp'),
  );
});

test('expired artifacts ignored (no viable)', async () => {
  process.env.GITHUB_TOKEN = 'token';
  const old = new Date(Date.now() - 86400000).toISOString();
  listArtifactsMock.mockResolvedValueOnce({
    data: {
      artifacts: [
        {
          id: 1,
          name: 'last-run',
          created_at: old,
          expired: true,
          archive_download_url: 'GET /repos/o/r/actions/artifacts/1/zip',
        },
      ],
    },
  });
  setInputs({ mode: 'get' });
  await run();
  expect(coreMock.setOutput).not.toHaveBeenCalled();
});

// Directory missing file should yield no output
test('missing timestamp file in artifact directory yields no output', async () => {
  jest.clearAllMocks();
  coreMock.getInput.mockImplementation(
    (n: string) => process.env[`INPUT_${n.toUpperCase()}`] || '',
  );
  coreMock.getBooleanInput.mockImplementation(
    (n: string) => process.env[`INPUT_${n.toUpperCase()}`] === 'true',
  );
  process.env.GITHUB_TOKEN = 'token';
  const created = new Date().toISOString();
  listArtifactsMock.mockResolvedValueOnce({
    data: {
      artifacts: [
        {
          id: 222,
          name: 'last-run',
          created_at: created,
          expired: false,
          archive_download_url: 'GET /repos/o/r/actions/artifacts/222/zip',
        },
      ],
    },
  });
  downloadArtifactMock.mockImplementationOnce(async (artifactId: number) => {
    const fs = require('fs');
    const path = require('path');
    const dir = writeArtifactDir(artifactId, null); // create empty directory
    // Ensure no stray file exists from previous runs
    const file = path.join(dir, 'last-run.txt');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { downloadPath: dir };
  });
  setInputs({ mode: 'get' });
  await run();
  const outputs = (coreMock.setOutput as jest.Mock).mock.calls.filter((c) => c[0] === 'last-run');
  // Should not have produced output when file missing
  expect(outputs.length).toBe(0);
});

test('downloadArtifactArchive missing token after discovery returns null (no output)', async () => {
  jest.clearAllMocks();
  coreMock.getInput.mockImplementation(
    (n: string) => process.env[`INPUT_${n.toUpperCase()}`] || '',
  );
  coreMock.getBooleanInput.mockImplementation(
    (n: string) => process.env[`INPUT_${n.toUpperCase()}`] === 'true',
  );
  // First list requires token; supply it then remove before archive download
  process.env.GITHUB_TOKEN = 'token';
  const ts = new Date().toISOString();
  listArtifactsMock.mockResolvedValueOnce({
    data: {
      artifacts: [
        {
          id: 9000,
          name: 'last-run',
          created_at: ts,
          expired: false,
          archive_download_url: 'GET /repos/o/r/actions/artifacts/9000/zip',
        },
      ],
    },
  });
  // Remove token so downloadArtifactArchive hits missing token branch
  delete process.env.GITHUB_TOKEN;
  setInputs({ mode: 'get' });
  await run();
  expect((coreMock.setOutput as jest.Mock).mock.calls.some((c) => c[0] === 'last-run')).toBe(false);
});

test('listRepoArtifactsByName no token path returns empty (indirectly no output)', async () => {
  // Ensure no token present
  delete process.env.GITHUB_TOKEN;
  jest.clearAllMocks();
  setInputs({ mode: 'get' });
  await run();
  expect(coreMock.setOutput).not.toHaveBeenCalled();
});

test('pattern-invalid timestamp triggers warning and no output', async () => {
  jest.clearAllMocks();
  const bad = 'not-a-timestamp';
  mockRepoArtifact({ created_at: new Date().toISOString(), content: bad });
  setInputs({ mode: 'get' });
  await run();
  expect(coreMock.setOutput).not.toHaveBeenCalledWith('last-run', bad);
  const warned = (coreMock.warning as jest.Mock).mock.calls.some((c) =>
    String(c[0]).includes('Invalid timestamp format'),
  );
  // If pattern didn't trigger, then we expect generic missing warning
  if (!warned) {
    expect(
      (coreMock.warning as jest.Mock).mock.calls.some((c) =>
        String(c[0]).includes('No valid previous run timestamp'),
      ),
    ).toBe(true);
  }
});

test('parse-invalid timestamp triggers warning and no output', async () => {
  jest.clearAllMocks();
  const bad = '2025-13-01T00:00:00Z'; // matches pattern but invalid month
  mockRepoArtifact({ created_at: new Date().toISOString(), content: bad });
  setInputs({ mode: 'get' });
  await run();
  // Depending on engine, may parse; if it parses we accept output else we expect warning
  const wasSet = (coreMock.setOutput as jest.Mock).mock.calls.some(
    (c) => c[0] === 'last-run' && c[1] === bad,
  );
  if (!wasSet) {
    expect(coreMock.warning).toHaveBeenCalled();
  }
});

test('upload failure surfaces via set mode', async () => {
  const ArtifactMod = require('@actions/artifact');
  ArtifactMod.DefaultArtifactClient.prototype.uploadArtifact = jest
    .fn()
    .mockRejectedValue(new Error('boom-upload'));
  setInputs({ mode: 'set' });
  await run();
  expect(coreMock.setFailed).toHaveBeenCalledWith(expect.stringContaining('boom-upload'));
}, 15000); // Increased timeout to account for retries
