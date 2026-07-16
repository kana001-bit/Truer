import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Mirrors the sister repos (Loomit) ESLint flat config: JS + typescript-eslint
// recommended, with `any` disallowed. Non-type-checked recommended (no parserOptions
// .project) keeps lint fast and config-free.
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.tmp/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error"
    }
  },
  {
    // Skill/tooling scripts are plain ESM run by Node; declare Node globals so
    // no-undef does not flag them (TS files get this off via tseslint).
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        Buffer: "readonly"
      }
    }
  }
);
