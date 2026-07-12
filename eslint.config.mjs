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
  }
);
