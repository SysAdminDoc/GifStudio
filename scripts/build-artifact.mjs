import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const templateUrl = new URL('src/index.template.html', root);
const artifactUrl = new URL('index.html', root);
const boundaries = [
  { token: '{{GIF_DECODER_SOURCE}}', path: 'src/gif-decoder.js' },
  { token: '{{GIF_ENCODER_SOURCE}}', path: 'src/gif-encoder.js' },
  { token: '{{APP_SOURCE}}', path: 'src/app.js' }
];

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, '\n');
}

export function renderArtifact() {
  let output = normalizeNewlines(fs.readFileSync(templateUrl, 'utf8'));
  for (const boundary of boundaries) {
    const matches = output.split(boundary.token).length - 1;
    assert.equal(matches, 1, `template must contain one ${boundary.token} marker`);
    const source = normalizeNewlines(
      fs.readFileSync(new URL(boundary.path, root), 'utf8')
    ).replace(/\n+$/g, '');
    output = output.replace(boundary.token, source);
  }
  assert.doesNotMatch(output, /\{\{[A-Z_]+_SOURCE\}\}/, 'unresolved source marker');
  return output.endsWith('\n') ? output : `${output}\n`;
}

const command = process.argv[2] || '--check';
const rendered = renderArtifact();

if (command === '--write') {
  fs.writeFileSync(artifactUrl, rendered, 'utf8');
  console.log(`generated index.html (${Buffer.byteLength(rendered)} bytes)`);
} else if (command === '--check') {
  const artifact = normalizeNewlines(fs.readFileSync(artifactUrl, 'utf8'));
  assert.equal(artifact, rendered, 'index.html is stale; run npm run build:artifact');
  console.log('artifact check passed: index.html matches source boundaries byte-for-byte');
} else {
  throw new Error(`Unknown option: ${command}`);
}
