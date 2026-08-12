import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium, firefox, webkit } from 'playwright';

const root = new URL('../', import.meta.url);
const pakoPackage = JSON.parse(fs.readFileSync(new URL('node_modules/pako/package.json', root), 'utf8'));
const upngSource = fs.readFileSync(new URL('vendor/upng-2.1.0.js', root), 'utf8');
const pakoBrowserSource = fs.readFileSync(new URL('vendor/pako-3.0.1.min.js', root), 'utf8');

// This records the pako 3.0.1 adoption gate. Future codec changes must update
// the version and rerun exact APNG byte, round-trip, and browser-lane checks.
const PAKO_3_GATE = Object.freeze({
  version: '3.0.1',
  baseline: 'pako 2.1.0',
  expectedSha256: '8c693bedf8ba2b2ed7d4b5527b7165c5f7fec37a4f25317e191609e222cf2737',
  expectedBytes: 282,
  expectedDelays: [100, 233],
  browsers: ['chromium', 'firefox', 'webkit']
});

const frameHex = [
  'ff0000ff00ff00ff0000ffffffff00ff00000080ffffffff',
  '00ffffffffffff00ffff00ff800000ff0080ffffff00ffff'
];

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function loadUPNG(pakoApi) {
  const context = { pako: pakoApi };
  context.window = context;
  vm.runInNewContext(upngSource, context, { filename: 'vendor/upng-2.1.0.js' });
  return context.UPNG;
}

function expectedFrames() {
  return frameHex.map(hex => Array.from(hexToBytes(hex)));
}

async function runNodeGate() {
  assert.equal(pakoPackage.version, PAKO_3_GATE.version, 'pako 3 adoption gate is out of date');
  const pakoApi = await import('pako');
  const UPNG = loadUPNG(pakoApi);
  const encoded = Buffer.from(UPNG.encode(
    frameHex.map(hex => hexToBytes(hex).buffer),
    3,
    2,
    0,
    PAKO_3_GATE.expectedDelays
  ));
  const decoded = UPNG.decode(encoded);
  const rgba = Array.from(UPNG.toRGBA8(decoded), buffer => Array.from(new Uint8Array(buffer)));
  const digest = crypto.createHash('sha256').update(encoded).digest('hex');
  assert.equal(digest, PAKO_3_GATE.expectedSha256, 'pako 3 changed the APNG byte stream');
  assert.equal(encoded.length, PAKO_3_GATE.expectedBytes, 'pako 3 changed APNG output size');
  assert.equal(decoded.frames.length, frameHex.length, 'pako 3 changed APNG frame count');
  assert.deepEqual(Array.from(decoded.frames, frame => frame.delay), PAKO_3_GATE.expectedDelays);
  assert.deepEqual(rgba, expectedFrames(), 'pako 3 APNG round-trip changed pixels');
  console.log('pako 3 Node APNG byte and round-trip parity passed');
}

async function runBrowserGate() {
  const browserTypes = { chromium, firefox, webkit };
  for (const browserName of PAKO_3_GATE.browsers) {
    const browser = await browserTypes[browserName].launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><title>GifStudio codec gate</title>');
      await page.addScriptTag({ content: pakoBrowserSource });
      await page.addScriptTag({ content: upngSource });
      const result = await page.evaluate(input => {
        const buffers = input.frames.map(hex => {
          const bytes = new Uint8Array(hex.length / 2);
          for (let index = 0; index < bytes.length; index++) {
            bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
          }
          return bytes.buffer;
        });
        const encoded = UPNG.encode(buffers, 3, 2, 0, input.delays);
        const decoded = UPNG.decode(encoded);
        return {
          bytes: encoded.byteLength,
          delays: decoded.frames.map(frame => frame.delay),
          rgba: UPNG.toRGBA8(decoded).map(buffer => Array.from(new Uint8Array(buffer)))
        };
      }, { frames: frameHex, delays: PAKO_3_GATE.expectedDelays });
      assert.equal(result.bytes, PAKO_3_GATE.expectedBytes, browserName + ' pako 3 output size changed');
      assert.deepEqual(result.delays, PAKO_3_GATE.expectedDelays, browserName + ' pako 3 delays changed');
      assert.deepEqual(result.rgba, expectedFrames(), browserName + ' pako 3 pixels changed');
      console.log(browserName + ' pako 3 APNG browser round-trip passed');
    } finally {
      await browser.close();
    }
  }
}

await runNodeGate();
await runBrowserGate();
console.log('pako 3.0.1 APNG adoption gate passed in Node, Chromium, Firefox, and WebKit');
