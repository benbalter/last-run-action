# CLAUDE.md

GitHub Action that records and reads a workflow's last run time, stored as an artifact. TypeScript in [`src/`](src/), tests in [`tests/`](tests/), bundled to [`dist/index.js`](dist/index.js) with ncc.

## Commands

- CI runs `npm run format:check`, `npm run lint`, `npm test`, and `npm run build` followed by a check that `dist/` has no diff. Run those before committing.
- `npm run all` runs the same steps but rewrites files with Prettier first. `prettier --check .` covers Markdown too.

## Generated files

- `dist/` is the bundle the Action runs. Rebuild with `npm run build` and commit it with any change to `src/` or dependencies, or CI fails. `npm ci` and `npm install` also rebuild it through the `prepare` script. For Renovate and Dependabot PRs, [`rebuild-dist.yml`](.github/workflows/rebuild-dist.yml) commits it for you.

## Releasing

Users pin `benbalter/last-run-action@v1` (releases are tagged `v1.x.y`, with `v1` moved to match). Moving `v1` or publishing a release ships to every workflow that uses it. Prepare a release PR if asked, but tag or publish only after the owner's explicit go-ahead, and push branches with `--no-follow-tags`.

## Gotchas

- The README's Inputs and Outputs sections restate [`action.yml`](action.yml) by hand. When you change an input, output, or default, update both.
