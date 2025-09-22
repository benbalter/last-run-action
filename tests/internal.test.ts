import { __test__ } from '../src/index';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import path from 'path';

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

function makeZip(files: Record<string, string>) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

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
      created_at: 'x',
      archive_download_url: 'GET /repos/o/r/actions/artifacts/1/zip',
    });
    expect(v).toBeNull();
  });

  test('downloadArtifactArchive writes zip', async () => {
    process.env.GITHUB_TOKEN = 't';
    request.mockResolvedValueOnce({ data: makeZip({ 'last-run.txt': 'value' }) });
    const meta = {
      id: 9,
      created_at: '2025-01-01T00:00:00Z',
      archive_download_url: 'GET /repos/o/r/actions/artifacts/9/zip',
    };
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

  test('extractTimestampFromZip success + validation', async () => {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addFile('last-run.txt', Buffer.from('2025-01-01T00:00:00.000Z', 'utf8'));
    const buf = zip.toBuffer();
    const tmp = path.join(process.cwd(), 'tmp-test.zip');
    await fs.writeFile(tmp, buf);
    const value = await __test__.extractTimestampFromZip(tmp);
    expect(value).toBe('2025-01-01T00:00:00.000Z');
  });

  test('extractTimestampFromZip missing entry returns null', async () => {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    const buf = zip.toBuffer();
    const tmp = path.join(process.cwd(), 'tmp-test2.zip');
    await fs.writeFile(tmp, buf);
    const value = await __test__.extractTimestampFromZip(tmp);
    expect(value).toBeNull();
  });

  test('validateIsoTimestamp identifies invalid patterns and parse errors', () => {
    expect(__test__.validateIsoTimestamp('')).toEqual({ ok: false, reason: 'empty' });
    expect(__test__.validateIsoTimestamp('not-a-date').ok).toBe(false);
    const good = '2025-12-31T23:59:59.123Z';
    expect(__test__.validateIsoTimestamp(good)).toEqual({ ok: true });
  });
});
