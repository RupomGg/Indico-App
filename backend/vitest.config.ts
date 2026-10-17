import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ["test/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgresql://test_user:test_pass@localhost:5432/test_db?schema=public",
      JWT_SECRET: "test-jwt-secret-at-least-32-characters-long-12345",
      INDICO_LEDGER_ADDRESS: "0xa51D54BAe8431f4c6f0dd644D2fCeb498CE5eeF0",
      USDC_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      DOCUMENT_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      NODE_ENV: "test",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      lines: 90,
      functions: 90,
      branches: 90,
      statements: 90,
      exclude: ["test/**", "dist/**", "node_modules/**"],
    },
  },
});
