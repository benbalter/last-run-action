import { __test__ } from '../src/index';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import path from 'path';

// Mock artifact client prior to import usage (hoisted)
jest.mock('@actions/artifact', () => {
  class MockArtifactClient {
    // For these internal helper tests we only need downloadArtifact when token provided
    async downloadArtifact(id: number): Promise<{ downloadPath: string }> {
      // create a trivial directory to simulate extracted artifact contents (empty)
      const tmpDir = path.join(process.cwd(), `internal-${id}`);
      await fs.mkdir(tmpDir, { recursive: true });
      return { downloadPath: tmpDir };
    }
  }
  return { DefaultArtifactClient: MockArtifactClient };
});

jest.mock('@actions/core');

// Minimal mocks for github
const listArtifactsForRepo = jest.fn();
const request = jest.fn();
jest.mock('@actions/github', () => ({
  getOctokit: () => ({
    rest: { actions: { listArtifactsForRepo } },
    request,
  }),
  context: { repo: { owner: 'o', repo: 'r' } },
}));

// Zip helper removed after migration to direct directory artifact handling.

describe('internal helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
    delete process.env.ACTIONS_RUNTIME_TOKEN;
  });

  test('listRepoArtifactsByName without token returns empty', async () => {
    const res = await __test__.listRepoArtifactsByName('last-run');
    expect(res).toEqual([]);
  });

  test('listRepoArtifactsByName with token returns mapped artifacts', async () => {
    process.env.GITHUB_TOKEN = 't';
    listArtifactsForRepo.mockResolvedValueOnce({
      data: {
        artifacts: [
          {
            id: 1,
            name: 'last-run',
            created_at: '2025-01-01T00:00:00Z',
            expired: false,
            archive_download_url: 'url',
          },
        ],
      },
    });
    const res = await __test__.listRepoArtifactsByName('last-run');
    expect(res.length).toBe(1);
    expect(res[0].id).toBe(1);
  });

  test('fetchLatestRepoArtifact filters expired and picks latest', async () => {
    process.env.GITHUB_TOKEN = 't';
    listArtifactsForRepo.mockResolvedValueOnce({
      data: {
        artifacts: [
          {
            id: 1,
            name: 'last-run',
            created_at: '2025-01-01T00:00:00Z',
            expired: true,
            archive_download_url: 'u1',
          },
          {
            id: 2,
            name: 'last-run',
            created_at: '2025-02-01T00:00:00Z',
            expired: false,
            archive_download_url: 'u2',
          },
          {
            id: 3,
            name: 'last-run',
            created_at: '2025-03-01T00:00:00Z',
            expired: false,
            archive_download_url: 'u3',
          },
        ],
      },
    });
    const latest = await __test__.fetchLatestRepoArtifact();
    expect(latest?.id).toBe(3);
  });

  test('downloadArtifactArchive returns null missing token', async () => {
    const v = await __test__.downloadArtifactArchive({
      id: 1,
      node_id: 'node',
      name: 'last-run',
      size_in_bytes: 0,
      url: 'url',
      archive_download_url: 'GET /repos/o/r/actions/artifacts/1/zip',
      expired: false,
      created_at: '2025-01-01T00:00:00Z',
      expires_at: '2030-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    } as any);
    expect(v).toBeNull();
  });

  test('downloadArtifactArchive returns path (uses mocked artifact client)', async () => {
    process.env.GITHUB_TOKEN = 't';
    const meta = {
      id: 9,
      node_id: 'n9',
      name: 'last-run',
      size_in_bytes: 10,
      url: 'url',
      archive_download_url: 'GET /repos/o/r/actions/artifacts/9/zip',
      expired: false,
      created_at: '2025-01-01T00:00:00Z',
      expires_at: '2030-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    } as any;
    const p = await __test__.downloadArtifactArchive(meta);
    expect(typeof p).toBe('string');
    if (p) {
      const exists = await fs
        .access(p)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    }
  });

  test('validateIsoTimestamp identifies invalid patterns and parse errors', () => {
    expect(__test__.validateIsoTimestamp('')).toEqual({ ok: false, reason: 'empty' });
    expect(__test__.validateIsoTimestamp('not-a-date').ok).toBe(false);
    const good = '2025-12-31T23:59:59.123Z';
    expect(__test__.validateIsoTimestamp(good)).toEqual({ ok: true });
  });
});
