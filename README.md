# Last Run Action

Determine (and/or update) the last time a workflow ran by storing a timestamp in a reusable repository-level Actions artifact. Provides simple modes to read, write, or atomically read-then-write the value.

## Usage

```yaml
# Example: capture previous timestamp then do work and update afterward (two steps)
permissions:
  actions: write # write needed because we will upload in the second step

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      # Retrieve previous timestamp
      - uses: benbalter/last-run-action@v1
        id: last-run
        with:
          mode: get

      - run: echo "Previous run was at ${{ steps.last-run.outputs.last-run }}"

      # Do your work here...
      - run: echo "(do stuff)"

      # Update timestamp
      - uses: benbalter/last-run-action@v1
        with:
          mode: set
```

Or atomically get the previous value and immediately store a newer one in a single invocation:

```yaml
permissions:
  actions: write

steps:
  - uses: actions/checkout@v5
  - uses: benbalter/last-run-action@v1
    id: last-run
    with:
      mode: get-and-set
  - run: echo "Previous run was at ${{ steps.last-run.outputs.last-run }}"
```

## Inputs

- `mode` (optional, default `get`): One of:
  - `get` – read a previously stored timestamp and set the `last-run` output. Uploads only to seed a baseline on the first run (see below).
  - `set` – store the current timestamp.
  - `get-and-set` – output the previous timestamp then upload a strictly newer timestamp.
    Aliases: `getset`, `get_and_set`.
  - Any unknown value logs a warning and behaves like a read-only `get` (never uploads).
- `fail-if-missing` (optional, default `false`): If `true` and no valid previous timestamp is
  found (missing, malformed, or unparsable), the action is marked failed. In combined
  modes the subsequent upload still proceeds so future runs have a seed value.
- `key` (optional, default `last-run`): Name of the artifact that stores the timestamp. All
  workflows in a repository share the default key, so give each workflow that uses this action
  its own key (e.g. `key: nightly-sync`). Include the branch if runs on different branches
  should be tracked separately. Characters not allowed in artifact names (such as `/` or `:`)
  are replaced with `-`.
- `retention-days` (optional, default `90`): How long the stored artifact is kept. Values above
  the repository's artifact retention setting are capped to it. If the workflow doesn't run within this
  window, the timestamp expires and the next run is treated as a first run.
- `token` (optional, default `${{ github.token }}`): Token used to list and download artifacts
  from previous runs. Falls back to the `GITHUB_TOKEN` environment variable.

## Outputs

- `last-run`: The last time the workflow was run, in ISO 8601 format. Omitted on first run (when there is no previously stored timestamp).
- `first-run`: `'true'` when no prior timestamp was found; `'false'` otherwise. Only meaningful for modes that include `get`.
- `current-run`: The timestamp this step stored, in ISO 8601 format. Set whenever a timestamp is uploaded (`set`, `get-and-set`, or first-run seeding).

## First run behavior

On the very first invocation there is no stored timestamp to retrieve. To make the common "do work since last run" pattern work without requiring a separate bootstrap step:

- With `mode: get` (default) and `fail-if-missing: false`: a warning is logged, the `last-run` output is omitted, `first-run` is set to `'true'`, and the action automatically uploads the current timestamp so the next run has a baseline. This requires `actions: write` permissions.
- With `mode: get-and-set`: the previous value is absent (no `last-run` output), `first-run` is set to `'true'`, and the new timestamp is uploaded as usual.
- With `fail-if-missing: true`: the action fails; no seeding occurs.

A `set` or `get-and-set` step later in the same run replaces the seed, so the two-step `get` … `set` pattern works on the first run too.

Downstream steps can guard first-run logic with `if: steps.last-run.outputs.first-run != 'true'` (or invert it to run one-time bootstrap work only on the first invocation).

## How it works

This Action stores the latest run timestamp in a single-file artifact:

Artifact name: `last-run`, file inside: `last-run.txt` containing an ISO 8601 (UTC) timestamp.

Retrieval performs a repository-level artifact listing filtered by name (the `key` input) and selects the newest non-expired artifact. Artifacts are downloaded into a temporary directory under `RUNNER_TEMP`, never into your workspace.

Because the timestamp is repository-wide state, overlapping runs of the same workflow can race. Add a `concurrency` group to workflows that use `set` or `get-and-set`:

```yaml
concurrency:
  group: ${{ github.workflow }}
```

### Permissions

- Reading existing timestamp: `actions: read` (listing & downloading artifacts)
- Writing new timestamp (modes `set`, `get-and-set`, or first-run seeding in `get`): `actions: write`

If you attempt an upload without `actions: write`, the step will fail during the upload phase. To opt out of first-run seeding in `get` mode, set `fail-if-missing: true` (the action will fail instead) or pre-seed the repository with a `mode: set` step under `actions: write`.

### Behavior summary

| Mode                               | Reads previous | Outputs `last-run`     | Uploads new timestamp |
| ---------------------------------- | -------------- | ---------------------- | --------------------- |
| get                                | Yes            | Yes (if found & valid) | Only on first run     |
| set                                | No             | No                     | Yes                   |
| get-and-set / getset / get_and_set | Yes            | Yes (previous value)   | Yes (new)             |

Aliases `getset` and `get_and_set` behave identically to `get-and-set`.

### Cross-run persistence rationale

Repository-level artifacts provide durable (retention-limited) cross-run storage without polluting the Git history or relying on caches that can be evicted unpredictably. Expired artifacts are ignored. If none are available yet (first run), the timestamp is simply missing.

### Fail-if-missing semantics

`fail-if-missing: true` triggers failure when retrieval yields no valid timestamp. Invalid format or parse failure is treated the same as absence. In `get-and-set`, the upload still proceeds.

## Use cases

- Downloading activity since the last run.
- Acting on changes since the last run.
- Running periodic tasks.

## Implementation notes

Storing the timestamp in an artifact avoids repository history churn. If no prior run exists, the output is omitted (and a warning logged); with `fail-if-missing: true` the action fails in that case.

### Timestamp validation

Retrieved values must match the regex `YYYY-MM-DDTHH:mm:ss(.fraction)?Z` and be parseable by `Date.parse`. Pattern or parse failures emit a warning and treat the value as missing.

### Monotonic updates

Whenever a previous timestamp was read in the same step, the stored timestamp is at least 1ms later than it, so values strictly increase even with very fast runs or clock skew.

### Combined mode advantages

Using `mode: get-and-set` in a single step lets you capture the prior value and atomically update it without two separate action invocations.

## Why not use the REST API to find the last run?

Using timestamps avoids ambiguity around selectively filtered runs (e.g., dry runs) and does not depend on workflow conclusion states or external filtering (like environment variables) to discern the relevant "last" run.

## Automated dependency updates

This repository uses [Renovate](https://docs.renovatebot.com/) (see `renovate.json`) to keep npm dependencies and GitHub Actions up to date.
