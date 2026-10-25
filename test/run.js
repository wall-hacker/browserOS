'use strict';
// Starts the harness in Electron (taken from the sibling Electron project, ../browserOS).
//   npm test                     all suites
//   npm test -- --suite=shell    one suite (basic | shell | streaming)
//   npm test -- --modern         don't hide newer browser APIs (see harness.js)

const { spawn } = require('child_process');
const path = require('path');

let electron;
try {
  electron = require(path.join(__dirname, '..', '..', 'browserOS', 'node_modules', 'electron'));
} catch (e) {
  console.error('Electron not found. Run `npm install` in ../browserOS first.');
  process.exit(1);
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE; // set by VS Code terminals; makes Electron start as plain Node
const child = spawn(electron, [path.join(__dirname, 'harness.js')].concat(process.argv.slice(2)), { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
