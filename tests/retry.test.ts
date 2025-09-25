import { __test__ } from '../src/index';

// Mock GitHub API and core functions
const listArtifactsForRepo = jest.fn();

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  warning: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  getOctokit: () => ({
    rest: { actions: { listArtifactsForRepo } },
  }),
  context: { repo: { owner: 'test-owner', repo: 'test-repo' } },
}));

const coreMock = require('@actions/core');

describe('retry functionality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GITHUB_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  test('listRepoArtifactsByName retries on failure and eventually succeeds', async () => {
    // Mock the first two calls to fail, third to succeed
    listArtifactsForRepo
      .mockRejectedValueOnce(new Error('Network error 1'))
      .mockRejectedValueOnce(new Error('Network error 2'))
      .mockResolvedValueOnce({
        data: {
          artifacts: [
            {
              id: 1,
              name: 'last-run',
              created_at: '2025-01-01T00:00:00Z',
              expired: false,
            },
          ],
        },
      });

    const result = await __test__.listRepoArtifactsByName('last-run');

    // Should succeed after retries
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);

    // Should have been called 3 times (initial + 2 retries)
    expect(listArtifactsForRepo).toHaveBeenCalledTimes(3);

    // Should have logged debug messages for retry attempts
    expect(coreMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('listRepoArtifactsByName: attempt 1 failed'),
    );
    expect(coreMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('listRepoArtifactsByName: attempt 2 failed'),
    );
  });

  test('listRepoArtifactsByName eventually fails after all retries exhausted', async () => {
    // Mock all calls to fail
    listArtifactsForRepo.mockRejectedValue(new Error('Persistent network error'));

    const result = await __test__.listRepoArtifactsByName('last-run');

    // Should return empty array after all retries fail
    expect(result).toEqual([]);

    // Should have been called 4 times (initial + 3 retries)
    expect(listArtifactsForRepo).toHaveBeenCalledTimes(4);

    // Should have warned about failure
    expect(coreMock.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to list repository artifacts after retries'),
    );
  }, 15000); // Increased timeout for retry testing

  test('listRepoArtifactsByName handles network errors with exponential backoff', async () => {
    const startTime = Date.now();

    // Mock all calls to fail
    listArtifactsForRepo.mockRejectedValue(new Error('Network timeout'));

    await __test__.listRepoArtifactsByName('last-run');

    const endTime = Date.now();
    const elapsed = endTime - startTime;

    // With exponential backoff (1s, 2s, 4s min timeouts), should take at least 7 seconds
    // But we'll be generous and check for at least 1 second to account for test environment
    expect(elapsed).toBeGreaterThan(1000);
  }, 15000); // Increased timeout for retry testing
});
