# Last Run Action

An action to determine when a workflow was last run.

## Usage

```yaml
permissions:
  actions: write

# Retrieve previous timestamp
- uses: actions/last-run-action@v1
  id: last-run
  with:
    mode: get

# Use the output
- run: echo "Previous run was at ${{ steps.last-run.outputs.last-run }}"

# Update timestamp after work is done
- uses: actions/last-run-action@v1
  with:
    mode: set
```

Or capture and update in a single step:

```yaml
- uses: actions/last-run-action@v1
  id: last-run
  with:
    mode: get-and-set
```

## Inputs

Inputs:

- `mode` (required): One of:
  - `get` – read a previously stored timestamp and set the `last-run` output.
  - `set` – store the current timestamp.
  - `get-and-set` – output the previous timestamp then immediately update it to now.
- `fail-if-missing` (optional): If `true` and no valid previous timestamp is found (missing artifact or invalid format), the action fails instead of continuing. Default: `false`.

## Outputs

- `last-run`: The last time the workflow was run, in ISO 8601 format.

## How it works

This Action stores the most recent run timestamp in a GitHub Actions artifact named `last-run` containing a single file `last-run.txt` with an ISO 8601 UTC timestamp. Retrieval proceeds in two tiers:

1. Current-run scope: It first attempts to locate an artifact produced earlier in the SAME workflow run (useful for multi-job workflows where one job sets and another gets).
2. Repository-wide fallback: If no current-run artifact is found, it uses the GitHub REST API (`GET /repos/{owner}/{repo}/actions/artifacts`) to list repository artifacts, filters for non-expired artifacts named `last-run`, and selects the newest by `created_at`. It then downloads the artifact archive and extracts `last-run.txt`.

If both lookups fail, the timestamp is considered missing.

### Permissions

Minimum recommended permissions:

```yaml
permissions:
  actions: read # needed to list / download existing artifacts (fallback)
  contents: read # typical default, not strictly required by this action itself
```

Add `actions: write` when you use modes that upload (`set` or `get-and-set`). Without write permission, uploads will fail and the action will report the error.

### Behavior summary

| Mode                               | Reads previous | Outputs `last-run`     | Uploads new timestamp |
| ---------------------------------- | -------------- | ---------------------- | --------------------- |
| get                                | Yes            | Yes (if found & valid) | No                    |
| set                                | No             | No                     | Yes                   |
| get-and-set / getset / get_and_set | Yes            | Yes (previous)         | Yes (new)             |

Aliases `getset` and `get_and_set` behave identically to `get-and-set`.

### Cross-run fallback rationale

Artifacts listed by the SDK client are scoped to the current run; relying solely on that would fail on the very first step of a new run. The repository-level fallback allows true _cross-run_ persistence without needing to commit a file back to the repository or misuse caches. Expired artifacts (per retention policy) are skipped.

### Fail-if-missing semantics

`fail-if-missing: true` only triggers failure after BOTH current-run lookup and repository-wide fallback fail to yield a valid ISO timestamp (or a retrieved value fails validation). Any invalid or unparsable timestamp is treated as missing.

## Use cases

- Downloading activity since the last run.
- Acting on changes since the last run.
- Running periodic tasks.

## Implementation notes

The artifact format and fallback layering are designed to minimize false negatives while avoiding repository history churn. If no prior run exists, the output is omitted (and a warning logged); with `fail-if-missing: true` the action fails in that case.

### Timestamp validation

Retrieved values must match the regex `YYYY-MM-DDTHH:mm:ss(.fraction)?Z` and be parseable by `Date.parse`. Pattern or parse failures emit a warning and treat the value as missing.

### Monotonic updates

When using `get-and-set`, a new timestamp is generated after reading the previous one. The action ensures the new timestamp is strictly greater (lexicographically) than the previous to avoid identical millisecond collisions in very fast runs.

### Combined mode advantages

Using `mode: get-and-set` in a single step lets you capture the prior value and atomically update it without two separate action invocations.

### Retry logic

Artifact list/download operations (current-run scope) and downloads are retried with exponential backoff (async-retry, 2 attempts). Repository-level listing is not currently retried; transient failures there fall back to a warning and a missing result.

### Versioning

This README reflects the initial v1 release surface which uses the unified `mode` input only.

## Why not use the REST API to find the last run?

I've found that sometimes the REST API does not return the most recent run (I suspect due to a timeout). Additionally, if you have `DRY_RUN` or similar flags for testing, you don't want the actual last run, but the last successful run of the workflow with that flag set to false.

## Automated dependency updates

This repository is configured with Dependabot to automatically open pull requests for:

- npm production and dev dependency updates (weekly; minor and patch changes grouped)
- GitHub Actions workflow updates (weekly)

The TypeScript version is pinned to `5.3.3` to align with the current ESLint / `@typescript-eslint` support range; Dependabot is configured to ignore newer TypeScript versions until toolchain support is updated. Adjust `.github/dependabot.yml` if you wish to allow automatic TypeScript bumps.
