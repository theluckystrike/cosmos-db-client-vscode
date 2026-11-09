'use strict';
// Bundles the extension host (dist/extension.js), the Cosmos DB SDK on its own (dist/sdk.js, loaded on the first
// connect only, so activation stays fast) and the webview (dist/webview.js) with esbuild. Pure JavaScript only.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: !prod, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
// extension.js loads ./sdk.js by a computed path, so esbuild leaves it out of the main bundle.
const keepSdkOut = { name: 'sdk-external', setup(b) { b.onResolve({ filter: /^\.\/sdk(\.js)?$/ }, () => ({ path: './sdk.js', external: true })); } };
Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], plugins: [keepSdkOut] }),
  esbuild.build({ ...common, entryPoints: ['src/sdk.js'], outfile: 'dist/sdk.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
  esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
]).catch(() => process.exit(1));
