import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readInlineScripts } from './load-inline-code.mjs';

const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
const readme = fs.readFileSync(new URL('README.md', root), 'utf8');
const serviceWorker = fs.readFileSync(new URL('coi-serviceworker.js', root), 'utf8');

const scripts = readInlineScripts();
assert.equal(scripts.length, 3, 'the shipped artifact must contain three inline scripts');
scripts.forEach((source, index) => {
  new vm.Script(source, { filename: `index.html#inline-script-${index + 1}` });
});
new vm.Script(serviceWorker, { filename: 'coi-serviceworker.js' });

assert.match(html, /<link rel="manifest" href="manifest\.json">/, 'manifest link is missing');
assert.match(html, /default-src 'none'/, 'restrictive CSP is missing');
assert.match(html, /navigator\.serviceWorker\.register\('coi-serviceworker\.js'\)/, 'service worker registration is missing');
assert.equal(manifest.start_url, './index.html');
assert.equal(manifest.scope, './');
assert.equal(manifest.display, 'standalone');
assert.ok(manifest.icons?.length, 'manifest icon is missing');
for (const icon of manifest.icons) {
  assert.ok(fs.existsSync(new URL(icon.src, root)), `manifest icon does not exist: ${icon.src}`);
}
assert.match(readme, new RegExp(`version-v${packageJson.version.replaceAll('.', '\\.')}`), 'README version badge is out of sync');

console.log(`release check passed: ${scripts.length} inline scripts, manifest, CSP, service worker, and v${packageJson.version}`);
