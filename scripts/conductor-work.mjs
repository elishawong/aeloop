#!/usr/bin/env node
import { run } from "../dist/conductor-work/main.js";

process.exitCode = run(process.argv.slice(2));
