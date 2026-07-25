import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGifDecoder } from '../scripts/load-inline-code.mjs';

const GifDecoder = loadGifDecoder();
const BASIC_GIF = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const TRANSPARENT_GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function bytesFromBase64(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('parses and decompresses a valid GIF89a frame', () => {
  const gif = GifDecoder.parseGIF(arrayBuffer(bytesFromBase64(BASIC_GIF)));
  assert.equal(gif.width, 1);
  assert.equal(gif.height, 1);
  assert.equal(gif.frames.length, 1);

  const [frame] = GifDecoder.decompressFrames(gif, true);
  assert.deepEqual(
    { left: frame.dims.left, top: frame.dims.top, width: frame.dims.width, height: frame.dims.height },
    { left: 0, top: 0, width: 1, height: 1 }
  );
  assert.equal(frame.patch.length, 4);
  assert.equal(frame.patch[3], 255);
});

test('preserves transparency, interlace, and disposal method 3 metadata', () => {
  const bytes = bytesFromBase64(TRANSPARENT_GIF);
  const graphicControlLabel = bytes.indexOf(0xF9);
  const imageSeparator = bytes.indexOf(0x2C);
  bytes[graphicControlLabel + 2] = 0x0D;
  bytes[imageSeparator + 9] = 0x40;

  const gif = GifDecoder.parseGIF(arrayBuffer(bytes));
  assert.equal(gif.frames[0].graphicControl.disposalMethod, 3);
  assert.equal(gif.frames[0].interlaced, true);

  const [frame] = GifDecoder.decompressFrames(gif, true);
  assert.equal(frame.disposalType, 3);
  assert.equal(frame.transparentIndex, 0);
  assert.equal(frame.patch[3], 0);
});

test('rejects truncated headers, sub-blocks, and missing trailers', () => {
  const bytes = bytesFromBase64(BASIC_GIF);
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(bytes.slice(0, 4))), /truncated header/);
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(bytes.slice(0, -1))), /missing trailer/);
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(bytes.slice(0, -2))), /truncated sub-block size/);
});

test('rejects malformed blocks and invalid LZW parameters', () => {
  const unknownBlock = bytesFromBase64(BASIC_GIF);
  unknownBlock[unknownBlock.length - 1] = 0x7F;
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(unknownBlock)), /unknown block 0x7f/);

  const badCodeSize = bytesFromBase64(BASIC_GIF);
  const imageSeparator = badCodeSize.indexOf(0x2C);
  badCodeSize[imageSeparator + 10] = 1;
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(badCodeSize)), /minimum code size 1/);
});

test('enforces shared frame-count and decoded-memory budgets', () => {
  assert.throws(() => GifDecoder.validateBudget(1, 1, 501), /500 frame maximum/);
  assert.throws(() => GifDecoder.validateBudget(4096, 4096, 5), /maximum is 256 MiB/);
  assert.throws(() => GifDecoder.validateBudget(8193, 1, 1), /8192×8192 maximum/);

  const budget = GifDecoder.validateBudget(1024, 1024, 10);
  assert.equal(budget.decodedBytes, 40 * 1024 * 1024);
});
