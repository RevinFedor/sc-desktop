import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          root: "./core",
          include: ["tests/**/*.test.ts"],
          setupFiles: ["tests/setup.ts"],
        },
      },
      {
        test: {
          name: "extension",
          root: "./extension",
          include: ["tests/**/*.test.ts"],
          setupFiles: ["tests/setup.ts"],
        },
      },
    ],
  },
});
