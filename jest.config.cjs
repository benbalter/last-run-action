/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    // Native ESM so the ESM-only @actions/* packages load; the rootDir
    // override lets ts-jest compile tests/ outside tsconfig's src rootDir
    '^.+\\.(ts|tsx)$': ['ts-jest', { useESM: true, tsconfig: { rootDir: '.' } }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/types.d.ts', '!src/index.ts'],
  coverageReporters: ['text', 'lcov'],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 60,
      functions: 95,
      lines: 90,
    },
  },
};
