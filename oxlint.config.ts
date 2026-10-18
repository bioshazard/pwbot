import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      files: ["lib/**/*.ts", "reply.ts", "slack.ts", "scripts/**/*.ts"],
      rules: {
        // Effect generators return values or yield typed failures on separate paths.
        "typescript/consistent-return": "off",
        // Promise SDK boundaries also legitimately return already-created Promises.
        "typescript/promise-function-async": "off",
      },
    },
    {
      files: ["test/**/*.ts"],
      rules: {
        // Bun types its asynchronous expect(...).rejects matchers as void.
        "typescript/await-thenable": "off",
        "typescript/no-confusing-void-expression": "off",
        "typescript/promise-function-async": "off",
      },
    },
  ],
});
