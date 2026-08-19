// The page bridge is served as web/harness-bridge.js (same-origin).
// This file exists so test/harness/ matches the layout in AGENTS.md.
module.exports = require('path').join(__dirname, '../../web/harness-bridge.js');
