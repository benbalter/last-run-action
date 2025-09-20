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

This Action uses GitHub Actions Artifacts to store the last time a Workflow was run.

## Use cases

- Downloading activity since the last run.
- Acting on changes since the last run.
- Running periodic tasks.

## Implementation notes

This Action stores a single `last-run.txt` file inside an artifact named `last-run`. In `set` or `get-and-set` modes the artifact is (re)created with the current timestamp in ISO 8601 format. In `get` or `get-and-set` modes the Action downloads the artifact (if present) and outputs its contents as `last-run`.

Because artifacts are persisted across workflow runs, the prior timestamp is discoverable via the Actions artifacts service. The Action requires `actions: read` permission to fetch and `actions: write` to upload when using `set` or `get-and-set`.

If no prior run exists, the output `last-run` will be empty and the Action logs that no previous timestamp was found. When `fail-if-missing: true`, the Action fails instead.

### Timestamp validation

Retrieved timestamps are validated to be ISO 8601 UTC form (`YYYY-MM-DDTHH:mm:ss(.fraction)Z`). Any malformed value in the artifact is treated as missing (and will trigger `fail-if-missing` if enabled).

### Combined mode advantages

Using `mode: get-and-set` in a single step lets you capture the prior value and atomically update it without two separate action invocations.

### Retry logic

Artifact list/download operations are retried with exponential backoff to mitigate transient service errors (2 retry attempts each). Failures after retries result in a warning (or failure if `fail-if-missing` applies and no valid timestamp is ultimately found).

### Versioning

This README reflects the initial v1 release surface which uses the unified `mode` input only.

## Why not use the REST API to find the last run?

I've found that sometimes the REST API does not return the most recent run (I suspect due to a timeout). Additionally, if you have `DRY_RUN` or similar flags for testing, you don't want the actual last run, but the last successful run of the workflow with that flag set to false.

## Automated dependency updates

This repository is configured with Dependabot to automatically open pull requests for:

- npm production and dev dependency updates (weekly; minor and patch changes grouped)
- GitHub Actions workflow updates (weekly)

The TypeScript version is pinned to `5.3.3` to align with the current ESLint / `@typescript-eslint` support range; Dependabot is configured to ignore newer TypeScript versions until toolchain support is updated. Adjust `.github/dependabot.yml` if you wish to allow automatic TypeScript bumps.
