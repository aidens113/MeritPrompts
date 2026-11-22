#!/usr/bin/env node
import { runHeavySlot } from './heavy-slot/run.mjs';

try { process.exitCode = await runHeavySlot(); }
catch (error) { console.error(`[heavy-slot] ${error.message}`); process.exitCode = 1; }
