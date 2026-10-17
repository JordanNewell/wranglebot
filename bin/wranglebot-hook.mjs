#!/usr/bin/env node
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/hooks/cc-hook.js");
process.exitCode = await main();
