#!/usr/bin/env node
'use strict';
const path = require('node:path');
Promise.resolve().then(() => require(path.resolve(__dirname, '../../custom-terminal/scripts/cleanup-build-artifacts.cjs')).main(['--apply']))
  .catch(error => console.warn('[BuildArtifactCleanup] kept artifacts: ' + error.message));
