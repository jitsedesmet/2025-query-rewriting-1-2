/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      include: [
        'lib/**/*.js',
      ],
    },
    include: [
      'test/**/*.test.ts',
    ],
    typecheck: {
      enabled: true,
      include: [
        'test/**/*.types.test.ts',
      ],
    },
  },
});
