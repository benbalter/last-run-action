# Last Run Action

Determine (and/or update) the last time a workflow ran by storing a timestamp in a reusable repository-level Actions artifact. Provides simple modes to read, write, or atomically
read-then-write the value.

## Usage

```yaml
# Example: capture previous timestamp then do work and update afterward (two steps)
permissions:
  actions: write # write needed because we will upload in the second step

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Retrieve previous timestamp
      - uses: actions/last-run-action@v1
        id: last-run
        with:
          mode: get

      - run: echo "Previous run was at ${{ steps.last-run.outputs.last-run }}"

      # Do your work here...
      - run: echo "(do stuff)"

      # Update timestamp
      - uses: actions/last-run-action@v1
        with:
          mode: set
```

Or atomically get the previous value and immediately store a newer one in a single invocation:

```yaml
permissions:
  actions: write

steps:
  - uses: actions/checkout@v4
  - uses: actions/last-run-action@v1
    id: last-run
    with:
      mode: get-and-set
  - run: echo "Previous run was at ${{ steps.last-run.outputs.last-run }}"
```

## Inputs

Inputs:

- `mode` (required): One of:
  - `get` – read a previously stored timestamp and set the `last-run` output (no upload).
  - `set` – store the current timestamp (no output).
  - `get-and-set` – output the previous timestamp then upload a strictly newer timestamp.
    Aliases: `getset`, `get_and_set`.
  - Any unknown value defaults to `get` (defensive, read‑only behavior).
- `fail-if-missing` (optional, default `false`): If `true` and no valid previous timestamp is
  found (missing, malformed, or unparsable), the action is marked failed. In combined
  modes the subsequent upload still proceeds so future runs have a seed value.

## Outputs

- `last-run`: The last time the workflow was run, in ISO 8601 format. Omitted on first run
  (when there is no previously stored timestamp).
- `first-run`: `'true'` when no prior timestamp was found (a fresh baseline was seeded);
  `'false'` otherwise. Only meaningful for modes that include `get`.

## First run behavior

On the very first invocation there is no stored timestamp to retrieve. To make the common
"do work since last run" pattern work without requiring a separate bootstrap step:

- With `mode: get` (default) and `fail-if-missing: false`: a warning is logged, the `last-run`
  output is omitted, `first-run` is set to `'true'`, and the action automatically uploads the
  current timestamp so the next run has a baseline. This requires `actions: write` permissions.
- With `mode: get-and-set`: the previous value is absent (no `last-run` output), `first-run`
  is set to `'true'`, and the new timestamp is uploaded as usual.
- With `fail-if-missing: true`: the action fails; no seeding occurs.

Downstream steps can guard first-run logic with `if: steps.last-run.outputs.first-run != 'true'`
(or invert it to run one-time bootstrap work only on the first invocation).

## How it works

This Action stores the latest run timestamp in a single-file artifact:

Artifact name: `last-run`, file inside: `last-run.txt` containing an ISO 8601 (UTC) timestamp.

Retrieval (current implementation) performs a repository-level artifact listing filtered by name and selects the newest non-expired artifact.

### Permissions

Permissions:

- Reading existing timestamp: `actions: read` (listing & downloading artifacts)
- Writing new timestamp (modes `set`, `get-and-set`, or first-run seeding in `get`): `actions: write`

If you attempt an upload without `actions: write`, the step will fail during the upload phase.
To opt out of first-run seeding in `get` mode, set `fail-if-missing: true` (the action will
fail instead) or pre-seed the repository with a `mode: set` step under `actions: write`.

### Behavior summary

| Mode                               | Reads previous | Outputs `last-run`     | Uploads new timestamp |
| ---------------------------------- | -------------- | ---------------------- | --------------------- |
| get                                | Yes            | Yes (if found & valid) | No                    |
| set                                | No             | No                     | Yes                   |
| get-and-set / getset / get_and_set | Yes            | Yes (previous value)   | Yes (new)             |

Aliases `getset` and `get_and_set` behave identically to `get-and-set`.

### Cross-run persistence rationale

Repository-level artifacts provide durable (retention-limited) cross-run storage without polluting
the Git history or relying on caches that can be evicted unpredictably. Expired artifacts are
ignored. If none are available yet (first run), the timestamp is simply missing.

### Fail-if-missing semantics

`fail-if-missing: true` triggers failure when retrieval yields no valid timestamp. Invalid format
or parse failure is treated the same as absence. In `get-and-set`, the upload still proceeds.

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

## Why not use the REST API to find the last run?

Using timestamps avoids ambiguity around selectively filtered runs (e.g., dry runs) and does not
depend on workflow conclusion states or external filtering (like environment variables) to discern
the relevant "last" run.

## Automated dependency updates

This repository is configured with Dependabot to automatically open pull requests for:

- npm production and dev dependency updates (weekly; minor and patch changes grouped)
- GitHub Actions workflow updates (weekly)
