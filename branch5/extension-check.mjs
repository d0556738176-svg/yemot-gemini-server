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
  'background.js', 'panel.html', 'panel.js', 'gemini.js', 'reply-parser.js'
];
const missingFiles = requiredFiles.filter(file => !fs.existsSync(path.join(root, file)));
const checks = {
  manifestVersion3: manifest.manifest_version === 3,
  expectedExtensionName: typeof manifest.name === 'string' && manifest.name.includes('Gemini Browser Bridge'),
  expectedVersion: manifest.version === '0.2.2',
  serviceWorkerDeclared: manifest.background?.service_worker === 'background.js',
  sidePanelDeclared: manifest.side_panel?.default_path === 'panel.html',
  geminiHostDeclared: Array.isArray(manifest.host_permissions) &&
    manifest.host_permissions.includes('https://gemini.google.com/*'),
  noStaticGeminiApiKey: !fs.readFileSync(path.join(root, 'background.js'), 'utf8').match(/AIza[0-9A-Za-z_-]{30,}/),
  requiredFilesPresent: missingFiles.length === 0
};

console.log(JSON.stringify({
  extensionDirectory: root,
  checks,
  missingFiles,
  note: 'Static package validation only. It does not prove Chrome loads the extension or that a Gemini session is authenticated.'
}, null, 2));

if (Object.values(checks).some(value => value !== true)) process.exitCode = 1;
