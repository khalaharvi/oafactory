#!/usr/bin/env node
// Standalone entry for the built-in Runner. It imports only agent.js, which
// imports only node: builtins, so this file runs from a bare copy of dist/.
import { agentMain } from './agent.js';

process.exitCode = await agentMain();
