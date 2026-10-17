#!/usr/bin/env node
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/daemon/cli.js");
process.exitCode = await main(process.argv.slice(2));
