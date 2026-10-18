import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.BRIDGE_EXTENSION_DIR;
if (!dir) {
  console.error('Set BRIDGE_EXTENSION_DIR to the extracted Gemini Browser Bridge extension directory.');
  process.exit(2);
}

const root = path.resolve(dir);
const manifestPath = path.join(root, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('manifest.json not found in BRIDGE_EXTENSION_DIR.');
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
  console.error('manifest.json is not valid JSON.');
  process.exit(2);
}

const requiredFiles = [
  'background.js', 'core.js', 'target.js', 'panel.html', 'panel.js',
  'panel.css', 'gemini.js', 'reply-parser.js'
];
const missingFiles = requiredFiles.filter(file => !fs.existsSync(path.join(root, file)));

const manifestFiles = new Set(['manifest.json']);
const addManifestPath = value => {
  if (typeof value === 'string' && value.trim()) manifestFiles.add(value);
};
addManifestPath(manifest.background?.service_worker);
addManifestPath(manifest.side_panel?.default_path);
addManifestPath(manifest.options_page);
addManifestPath(manifest.options_ui?.page);
addManifestPath(manifest.action?.default_popup);
for (const file of Object.values(manifest.icons || {})) addManifestPath(file);
for (const file of Object.values(manifest.action?.default_icon || {})) addManifestPath(file);
for (const script of manifest.content_scripts || []) {
  for (const file of script.js || []) addManifestPath(file);
  for (const file of script.css || []) addManifestPath(file);
}
const missingManifestFiles = [...manifestFiles].filter(file => !fs.existsSync(path.join(root, file)));

const sourceFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (/\.(?:js|mjs|cjs|json|html|css|py)$/i.test(entry.name)) sourceFiles.push(fullPath);
  }
}
walk(root);
const apiKeyPattern = /AIza[0-9A-Za-z_-]{30,}/;
const literalApiKeyFiles = sourceFiles
  .filter(file => apiKeyPattern.test(fs.readFileSync(file, 'utf8')))
  .map(file => path.relative(root, file));

const checks = {
  manifestVersion3: manifest.manifest_version === 3,
  expectedExtensionName: typeof manifest.name === 'string' && manifest.name.includes('Gemini Browser Bridge'),
  expectedVersion: manifest.version === '0.2.2',
  serviceWorkerDeclared: manifest.background?.service_worker === 'background.js',
  sidePanelDeclared: manifest.side_panel?.default_path === 'panel.html',
  geminiHostDeclared: Array.isArray(manifest.host_permissions) &&
    manifest.host_permissions.includes('https://gemini.google.com/*'),
  requiredFilesPresent: missingFiles.length === 0,
  manifestReferencedFilesPresent: missingManifestFiles.length === 0,
  noLiteralGoogleApiKeyPattern: literalApiKeyFiles.length === 0,
  sourceFilesActuallyScanned: sourceFiles.length > 0
};

console.log(JSON.stringify({
  extensionDirectory: root,
  checks,
  missingFiles,
  missingManifestFiles,
  manifestFilesChecked: [...manifestFiles],
  literalApiKeyFiles,
  sourceFilesScanned: sourceFiles.length,
  note: 'Static package validation only. It does not prove Chrome loads the extension or that a Gemini session is authenticated.'
}, null, 2));

if (Object.values(checks).some(value => value !== true)) process.exitCode = 1;
