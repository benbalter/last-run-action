import { jest } from '@jest/globals';
import type * as Core from '@actions/core';

// ESM mocks need an explicit factory (no automock), so stub every
// @actions/core function src/main.ts uses, plus setSecret, which the real
// @actions/artifact imports when a test doesn't mock it.
export function coreMockFactory() {
  return {
    debug: jest.fn<typeof Core.debug>(),
    info: jest.fn<typeof Core.info>(),
    warning: jest.fn<typeof Core.warning>(),
    setFailed: jest.fn<typeof Core.setFailed>(),
    setOutput: jest.fn<typeof Core.setOutput>(),
    getInput: jest.fn<typeof Core.getInput>(),
    getBooleanInput: jest.fn<typeof Core.getBooleanInput>(),
    startGroup: jest.fn<typeof Core.startGroup>(),
    endGroup: jest.fn<typeof Core.endGroup>(),
    setSecret: jest.fn<typeof Core.setSecret>(),
  };
}
