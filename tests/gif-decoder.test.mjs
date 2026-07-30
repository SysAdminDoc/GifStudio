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

function insertBytes(bytes, offset, inserted) {
  const result = new Uint8Array(bytes.length + inserted.length);
  result.set(bytes.slice(0, offset));
  result.set(inserted, offset);
  result.set(bytes.slice(offset), offset + inserted.length);
  return result;
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

test('rejects every truncated prefix of the seed corpus', { timeout: 2_000 }, () => {
  for (const encoded of [BASIC_GIF, TRANSPARENT_GIF]) {
    const bytes = bytesFromBase64(encoded);
    for (let length = 0; length < bytes.length; length++) {
      assert.throws(
        () => GifDecoder.parseGIF(arrayBuffer(bytes.slice(0, length))),
        /Invalid GIF|Not a GIF/
      );
    }
  }
});

test('rejects invalid logical screens, frame rectangles, palettes, and control blocks', () => {
  const zeroWidth = bytesFromBase64(BASIC_GIF);
  zeroWidth[6] = 0;
  zeroWidth[7] = 0;
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(zeroWidth)), /dimensions must be positive/);

  const oversized = bytesFromBase64(BASIC_GIF);
  oversized[6] = 0x01;
  oversized[7] = 0x20;
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(oversized)), /8192×8192 maximum/);

  const zeroFrame = bytesFromBase64(BASIC_GIF);
  const imageSeparator = zeroFrame.indexOf(0x2C);
  zeroFrame[imageSeparator + 5] = 0;
  zeroFrame[imageSeparator + 6] = 0;
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(zeroFrame)), /frame dimensions must be positive/);

  const outsideFrame = bytesFromBase64(BASIC_GIF);
  outsideFrame[imageSeparator + 1] = 1;
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(outsideFrame)), /outside the logical screen/);

  const paletteSeed = bytesFromBase64(BASIC_GIF);
  const noPalette = new Uint8Array(paletteSeed.length - 6);
  noPalette.set(paletteSeed.slice(0, 13));
  noPalette.set(paletteSeed.slice(19), 13);
  noPalette[10] &= 0x7F;
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(noPalette)), /has no color table/);

  const badControlSize = bytesFromBase64(TRANSPARENT_GIF);
  const controlLabel = badControlSize.indexOf(0xF9);
  badControlSize[controlLabel + 1] = 3;
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(badControlSize)), /block size is 3/);

  const badControlTerminator = bytesFromBase64(TRANSPARENT_GIF);
  badControlTerminator[controlLabel + 6] = 1;
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(badControlTerminator)), /missing its terminator/);
});

test('bounds extension and image sub-block accumulation', () => {
  const bytes = bytesFromBase64(BASIC_GIF);
  const imageSeparator = bytes.indexOf(0x2C);
  const comment = new Uint8Array([
    0x21, 0xFE,
    3, 1, 2, 3,
    3, 4, 5, 6,
    0
  ]);
  const withComment = insertBytes(bytes, imageSeparator, comment);

  assert.equal(GifDecoder.parseGIF(arrayBuffer(withComment), { maxSubBlockBytes: 6 }).frames.length, 1);
  assert.throws(
    () => GifDecoder.parseGIF(arrayBuffer(withComment), { maxSubBlockBytes: 5 }),
    /sub-block data exceeds the 5 byte maximum/
  );
  assert.throws(
    () => GifDecoder.parseGIF(arrayBuffer(bytes), { maxInputBytes: bytes.length - 1 }),
    /maximum is/
  );

  const emptyImageData = bytesFromBase64(BASIC_GIF);
  emptyImageData[imageSeparator + 11] = 0;
  assert.throws(() => GifDecoder.parseGIF(arrayBuffer(emptyImageData)), /has no image data/);
});

test('covers LZW code-size and dictionary boundaries without unbounded work', { timeout: 2_000 }, () => {
  const seed = bytesFromBase64(BASIC_GIF);
  const imageSeparator = seed.indexOf(0x2C);
  for (const codeSize of [0, 1, 9, 255]) {
    const bytes = seed.slice();
    bytes[imageSeparator + 10] = codeSize;
    assert.throws(
      () => GifDecoder.parseGIF(arrayBuffer(bytes)),
      new RegExp(`minimum code size ${codeSize}`)
    );
  }

  let rejectedPayloads = 0;
  for (const payload of [0x00, 0xFF, 0x04, 0x7F]) {
    const bytes = seed.slice();
    bytes[imageSeparator + 12] = payload;
    const gif = GifDecoder.parseGIF(arrayBuffer(bytes));
    try {
      const [frame] = GifDecoder.decompressFrames(gif, true);
      assert.equal(frame.patch.length, 4);
    } catch (error) {
      assert.match(error.message, /Invalid GIF/);
      rejectedPayloads++;
    }
  }
  assert.ok(rejectedPayloads >= 1);
});

test('preserves interlace and disposal sequences across multiple frames', () => {
  for (let disposal = 0; disposal <= 7; disposal++) {
    const bytes = bytesFromBase64(TRANSPARENT_GIF);
    const controlLabel = bytes.indexOf(0xF9);
    const imageSeparator = bytes.indexOf(0x2C);
    bytes[controlLabel + 2] = (disposal << 2) | 1;
    bytes[imageSeparator + 9] |= 0x40;
    const [frame] = GifDecoder.decompressFrames(GifDecoder.parseGIF(arrayBuffer(bytes)), true);
    assert.equal(frame.disposalType, disposal);
    assert.equal(frame.patch[3], 0);
  }

  const bytes = bytesFromBase64(TRANSPARENT_GIF);
  const imageSeparator = bytes.indexOf(0x2C);
  const trailer = bytes.lastIndexOf(0x3B);
  const imageBlock = bytes.slice(imageSeparator, trailer);
  const twoFrames = insertBytes(bytes, trailer, imageBlock);
  const gif = GifDecoder.parseGIF(arrayBuffer(twoFrames));
  assert.equal(gif.frames.length, 2);
  assert.ok(gif.frames[0].graphicControl);
  assert.equal(gif.frames[1].graphicControl, null);
  assert.equal(GifDecoder.decompressFrames(gif, true).length, 2);
  assert.throws(
    () => GifDecoder.parseGIF(arrayBuffer(twoFrames), { maxFrames: 1 }),
    /1 frame maximum/
  );
});

test('deterministic byte mutations always decode or reject within parser limits', { timeout: 5_000 }, () => {
  const seed = bytesFromBase64(TRANSPARENT_GIF);
  const runCorpus = () => {
    const outcomes = [];
    for (let offset = 0; offset < seed.length; offset++) {
      for (const mask of [0x01, 0x55, 0xFF]) {
        const bytes = seed.slice();
        bytes[offset] ^= mask;
        try {
          const gif = GifDecoder.parseGIF(arrayBuffer(bytes), {
            maxWidth: 64,
            maxHeight: 64,
            maxFrames: 4,
            maxDecodedBytes: 64 * 64 * 4 * 4,
            maxInputBytes: 1024,
            maxSubBlockBytes: 512
          });
          const frames = GifDecoder.decompressFrames(gif, true);
          assert.ok(frames.length >= 1 && frames.length <= 4);
          frames.forEach(frame => assert.equal(frame.patch.length, frame.dims.width * frame.dims.height * 4));
          outcomes.push('decoded');
        } catch (error) {
          assert.equal(typeof error?.message, 'string');
          assert.ok(error.message.length > 0 && error.message.length < 300);
          outcomes.push('rejected');
        }
      }
    }
    return outcomes;
  };

  const first = runCorpus();
  const second = runCorpus();
  assert.deepEqual(second, first);
  assert.ok(first.includes('decoded'));
  assert.ok(first.includes('rejected'));
});
