// Action entrypoint: bundled by ncc into dist/index.js. Logic lives in main.ts
// so tests can import it without triggering a run.
import { run } from './main';

run();
