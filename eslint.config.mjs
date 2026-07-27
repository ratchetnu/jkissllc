import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The codebase uses a leading underscore to mark a deliberately discarded binding —
    // most importantly the destructures that strip sensitive fields before a record is
    // returned (toSafeUser, customerView). Those bindings exist precisely so the field
    // is NOT in the rest object, so flagging them as "unused" is backwards. Codifying
    // the convention here also removes the need for `void _x` workarounds.
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent/session scratch space. `.claude/worktrees/**` holds full checkouts of
    // OTHER branches plus their build output — tens of thousands of lint problems
    // that belong to code this config is not responsible for. Linting them made
    // `npm run lint` report ~39k problems on an otherwise clean tree, which buried
    // any real error and made the exit code useless as a signal.
    // This hides NO tracked application code: every path here is untracked.
    ".claude/**",
    // Disposable local-audit artifacts (KV emulator pid/dumps).
    ".local-audit/**",
  ]),
]);

export default eslintConfig;
