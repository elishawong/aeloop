#!/usr/bin/env node
// Real production CLI entry point (PRD §6.7) — compiled to `dist/cli/bin.js`,
// `package.json`'s `bin.aeloop` field. Deliberately two lines: every default
// (`process.env`, `loadProfile()`'s package-relative `profilesRoot`,
// `InquirerPrompter`) is `main()`'s own production default — this file
// passes no overrides at all, unlike `src/cli.e2e.test.ts` (B8), which
// drives `main()` directly with fixture overrides instead of going through
// this file.
import { main } from "./main.js";

await main(process.argv.slice(2));
