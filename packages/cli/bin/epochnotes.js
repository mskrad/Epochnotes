#!/usr/bin/env node
// Committed launcher: it exists before the first build, so `npm ci` can link the `epochnotes` bin.
import '../dist/bin.js';
