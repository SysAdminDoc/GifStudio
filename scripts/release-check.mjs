import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { readInlineScripts, readSourceScripts } from './load-inline-code.mjs';

const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
const readme = fs.readFileSync(new URL('README.md', root), 'utf8');
const serviceWorker = fs.readFileSync(new URL('coi-serviceworker.js', root), 'utf8');
const integrityManifest = JSON.parse(fs.readFileSync(new URL('vendor/integrity.json', root), 'utf8'));
const PWA_THEME_COLOR = '#101311';
const REQUIRED_ICON_VARIANTS = new Set([
  'any:192x192',
  'any:512x512',
  'maskable:192x192',
  'maskable:512x512'
]);

function pngDimensions(path) {
  const bytes = fs.readFileSync(path);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'icon is not a PNG: ' + path.pathname);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', 'PNG header is invalid: ' + path.pathname);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

const scripts = readInlineScripts();
const sourceScripts = readSourceScripts();
assert.equal(scripts.length, 3, 'the shipped artifact must contain three inline scripts');
assert.equal(sourceScripts.length, 3, 'three JavaScript source boundaries are required');
scripts.forEach((source, index) => {
  new vm.Script(source, { filename: `index.html#inline-script-${index + 1}` });
  new vm.Script(sourceScripts[index], {
    filename: ['src/gif-decoder.js', 'src/gif-encoder.js', 'src/app.js'][index]
  });
  const normalizedInline = source.replace(/^\n/, '').replace(/\n\s*$/, '');
  assert.equal(normalizedInline, sourceScripts[index], `inline script ${index + 1} differs from its source boundary`);
});
new vm.Script(serviceWorker, { filename: 'coi-serviceworker.js' });

assert.match(html, /<link rel="manifest" href="manifest\.json">/, 'manifest link is missing');
assert.match(html, /default-src 'none'/, 'restrictive CSP is missing');
assert.doesNotMatch(html, /cdn\.jsdelivr\.net/, 'shipped HTML must not execute mutable CDN code');
assert.match(html, /navigator\.serviceWorker\.register\('coi-serviceworker\.js'\)/, 'service worker registration is missing');
assert.match(html, new RegExp(`const APP_VERSION = '${packageJson.version.replaceAll('.', '\\.')}'`), 'HTML app version is out of sync');
assert.match(serviceWorker, new RegExp(`const APP_VERSION = '${packageJson.version.replaceAll('.', '\\.')}'`), 'service worker version is out of sync');
assert.match(html, new RegExp('<meta name="theme-color" content="' + PWA_THEME_COLOR + '">'), 'HTML theme color is out of sync');
assert.equal(manifest.start_url, './index.html');
assert.equal(manifest.id, './index.html');
assert.equal(manifest.scope, './');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.background_color, PWA_THEME_COLOR);
assert.equal(manifest.theme_color, PWA_THEME_COLOR);
assert.equal(manifest.name, 'GifStudio');
assert.equal(manifest.short_name, 'GifStudio');
assert.ok(manifest.icons?.length, 'manifest icon is missing');
for (const icon of manifest.icons) {
  assert.ok(fs.existsSync(new URL(icon.src, root)), `manifest icon does not exist: ${icon.src}`);
}
const iconVariants = new Set();
for (const icon of manifest.icons) {
  const path = new URL(icon.src, root);
  assert.equal(icon.type, 'image/png', 'manifest icon type is not PNG: ' + icon.src);
  const dimensions = pngDimensions(path);
  assert.equal(icon.sizes, dimensions.width + 'x' + dimensions.height, 'manifest icon dimensions are wrong: ' + icon.src);
  for (const purpose of (icon.purpose ?? 'any').split(/\s+/)) {
    iconVariants.add(purpose + ':' + icon.sizes);
  }
  assert.match(serviceWorker, new RegExp(icon.src.replaceAll('.', '\\.')), 'service worker does not cache: ' + icon.src);
}
for (const variant of REQUIRED_ICON_VARIANTS) {
  assert.ok(iconVariants.has(variant), 'manifest icon variant is missing: ' + variant);
}

for (const [filename, metadata] of Object.entries(integrityManifest)) {
  const path = new URL(`vendor/${filename}`, root);
  assert.ok(fs.existsSync(path), `vendored asset does not exist: ${filename}`);
  const bytes = fs.readFileSync(path);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const sri = `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
  assert.equal(hash, metadata.sha256, `vendored asset hash changed: ${filename}`);
  assert.equal(sri, metadata.integrity, `vendored asset SRI changed: ${filename}`);
  assert.match(html, new RegExp(metadata.integrity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `HTML SRI is missing: ${filename}`);
  assert.match(serviceWorker, new RegExp(filename.replaceAll('.', '\\.')), `service worker does not cache: ${filename}`);
}
assert.match(readme, new RegExp(`version-v${packageJson.version.replaceAll('.', '\\.')}`), 'README version badge is out of sync');

console.log(`release check passed: ${scripts.length} inline scripts, manifest, CSP, service worker, and v${packageJson.version}`);
