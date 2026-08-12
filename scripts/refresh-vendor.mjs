import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPackage = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
const integrityUrl = new URL('vendor/integrity.json', root);
const vendorUrl = new URL('vendor/', root);
const integrationFiles = [
  'src/app.js',
  'src/index.template.html',
  'coi-serviceworker.js',
  'tests/editor.e2e.mjs',
  'README.md'
];
const codecSpecs = [
  {
    packageName: 'pako',
    assetSources: {
      '2': 'dist/pako.min.js',
      '3': 'dist/browser/pako.umd.min.js'
    },
    assetFilename: version => 'pako-' + version + '.min.js',
    licenseFilename: version => 'pako-' + version + '.LICENSE.txt'
  },
  {
    packageName: 'upng-js',
    assetSources: { '2': 'UPNG.js' },
    assetFilename: version => 'upng-' + version + '.js',
    licenseFilename: version => 'upng-' + version + '.LICENSE.txt'
  },
  {
    packageName: 'gifsicle-wasm-browser',
    assetSources: { '1': 'dist/gifsicle.min.js' },
    assetFilename: version => 'gifsicle-wasm-browser-' + version + '.min.js',
    licenseFilename: version => 'gifsicle-wasm-browser-' + version + '.LICENSE.txt'
  }
];

function packageInfo(spec) {
  const requested = rootPackage.devDependencies?.[spec.packageName];
  assert.match(
    requested || '',
    /^\d+\.\d+\.\d+$/,
    spec.packageName + ' must use an exact semver in package.json'
  );
  const packageUrl = new URL('node_modules/' + spec.packageName + '/package.json', root);
  const metadata = JSON.parse(fs.readFileSync(packageUrl, 'utf8'));
  assert.equal(metadata.version, requested, spec.packageName + ' does not match package.json');
  const major = metadata.version.split('.')[0];
  const assetSource = spec.assetSources[major];
  assert.ok(assetSource, 'unsupported ' + spec.packageName + ' major version: ' + major);
  return {
    packageName: spec.packageName,
    version: metadata.version,
    license: metadata.license,
    assetSource,
    assetName: spec.assetFilename(metadata.version),
    licenseName: spec.licenseFilename(metadata.version),
    assetUrl: new URL('node_modules/' + spec.packageName + '/' + assetSource, root),
    licenseUrl: new URL('node_modules/' + spec.packageName + '/LICENSE', root)
  };
}

function hashAsset(bytes) {
  const hash = crypto.createHash('sha256');
  return {
    sha256: hash.update(bytes).digest('hex'),
    integrity: 'sha256-' + crypto.createHash('sha256').update(bytes).digest('base64')
  };
}

function transformAsset(info, sourceBytes) {
  if (info.packageName !== 'upng-js') {
    return { bytes: sourceBytes };
  }
  const source = sourceBytes.toString('utf8');
  const needle = 'var data = new Uint8Array(bufs[0].byteLength*bufs.length+100);';
  const replacement = [
    '// Upstream\'s raw-bytes + 100 allocation truncates small APNGs and can omit',
    '\t// frame/chunk overhead. Reserve filtered scanlines, worst-case DEFLATE block',
    '\t// overhead, palette metadata, and per-frame APNG control chunks.',
    '\tvar rawBytes = bufs[0].byteLength*bufs.length, filteredBytes = rawBytes+h*bufs.length;',
    '\tvar data = new Uint8Array(filteredBytes+Math.ceil(filteredBytes/16383)*5+65536+bufs.length*64);'
  ].join('\n');
  assert.equal(source.split(needle).length - 1, 1, 'UPNG.js allocation patch anchor changed');
  const patched = source.replace(needle, replacement).replace(/\n\n$/, '\n');
  return {
    bytes: Buffer.from(patched, 'utf8'),
    patch: 'apng-allocation-guard-v1'
  };
}

function expectedEntries() {
  return codecSpecs.map(spec => {
    const info = packageInfo(spec);
    const transformed = transformAsset(info, fs.readFileSync(info.assetUrl));
    const bytes = transformed.bytes;
    return {
      info,
      bytes,
      licenseBytes: fs.readFileSync(info.licenseUrl),
      metadata: {
        package: info.packageName,
        version: info.version,
        source: info.assetSource,
        licenseFile: info.licenseName,
        license: info.license,
        ...(transformed.patch ? { patch: transformed.patch } : {}),
        ...hashAsset(bytes)
      }
    };
  });
}

function readExistingManifest() {
  if (!fs.existsSync(integrityUrl)) return {};
  return JSON.parse(fs.readFileSync(integrityUrl, 'utf8'));
}

function pathForVendor(name) {
  return new URL('vendor/' + name, root);
}

function assertBytesEqual(actual, expected, message) {
  assert.equal(Buffer.compare(actual, expected), 0, message);
}

function check(entries) {
  const expectedManifest = Object.fromEntries(entries.map(entry => [
    entry.info.assetName,
    entry.metadata
  ]));
  const actualManifest = readExistingManifest();
  assert.deepEqual(
    actualManifest,
    expectedManifest,
    'vendor/integrity.json is stale; run npm run refresh:vendor'
  );
  for (const entry of entries) {
    assertBytesEqual(
      fs.readFileSync(pathForVendor(entry.info.assetName)),
      entry.bytes,
      'vendored payload drifted: ' + entry.info.assetName
    );
    assertBytesEqual(
      fs.readFileSync(pathForVendor(entry.info.licenseName)),
      entry.licenseBytes,
      'vendored license drifted: ' + entry.info.licenseName
    );
  }
  console.log('vendor check passed: ' + entries.length + ' package payloads, licenses, and integrity records');
}

function updateReferences(entries, oldManifest) {
  const replacements = [];
  for (const oldName of Object.keys(oldManifest)) {
    const oldMetadata = oldManifest[oldName];
    const entry = entries.find(candidate =>
      candidate.info.packageName === oldMetadata.package ||
      oldName.startsWith(candidate.info.packageName + '-')
    );
    if (!entry) continue;
    const oldVersion = oldMetadata.version ||
      oldName.match(/-(\d+\.\d+\.\d+)(?:\.min)?\.js$/)?.[1];
    replacements.push(
      [oldName, entry.info.assetName],
      [oldMetadata.integrity, entry.metadata.integrity]
    );
    if (oldVersion) {
      replacements.push([
        entry.info.packageName + ' ' + oldVersion,
        entry.info.packageName + ' ' + entry.info.version
      ]);
    }
  }

  let changed = false;
  for (const relativePath of integrationFiles) {
    const path = new URL(relativePath, root);
    let source = fs.readFileSync(path, 'utf8');
    const original = source;
    for (const [from, to] of replacements) {
      if (from && from !== to) source = source.replaceAll(from, to);
    }
    if (source !== original) {
      fs.writeFileSync(path, source, 'utf8');
      changed = true;
    }
  }
  return changed;
}

function write(entries) {
  fs.mkdirSync(vendorUrl, { recursive: true });
  const oldManifest = readExistingManifest();
  const changedReferences = updateReferences(entries, oldManifest);
  const activeNames = new Set();
  for (const entry of entries) {
    activeNames.add(entry.info.assetName);
    activeNames.add(entry.info.licenseName);
    fs.writeFileSync(pathForVendor(entry.info.assetName), entry.bytes);
    fs.writeFileSync(pathForVendor(entry.info.licenseName), entry.licenseBytes);
  }
  for (const oldName of Object.keys(oldManifest)) {
    const oldLicense = oldManifest[oldName].licenseFile ||
      oldName.replace(/\.min\.js$/, '.LICENSE.txt').replace(/\.js$/, '.LICENSE.txt');
    for (const staleName of [oldName, oldLicense]) {
      if (staleName && !activeNames.has(staleName)) {
        const stalePath = pathForVendor(staleName);
        if (fs.existsSync(stalePath)) fs.rmSync(stalePath);
      }
    }
  }
  const manifest = Object.fromEntries(entries.map(entry => [
    entry.info.assetName,
    entry.metadata
  ]));
  fs.writeFileSync(integrityUrl, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  if (changedReferences) {
    const build = spawnSync(
      process.execPath,
      ['scripts/build-artifact.mjs', '--write'],
      { cwd: fileURLToPath(root), encoding: 'utf8' }
    );
    if (build.status !== 0) {
      process.stderr.write(build.stderr || '');
      throw new Error('failed to regenerate index.html after vendor refresh');
    }
    process.stdout.write(build.stdout || '');
  }
  check(entries);
  console.log('vendor refresh staged exact package payloads and licenses');
}

const command = process.argv[2] || '--check';
const entries = expectedEntries();
if (command === '--check') {
  check(entries);
} else if (command === '--write') {
  write(entries);
} else {
  throw new Error('Unknown option: ' + command);
}
