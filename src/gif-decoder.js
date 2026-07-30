    const GifDecoder = (() => {
        const DEFAULT_LIMITS = Object.freeze({
            maxWidth: 8192,
            maxHeight: 8192,
            maxFrames: 500,
            maxDecodedBytes: 256 * 1024 * 1024,
            maxInputBytes: 128 * 1024 * 1024,
            maxSubBlockBytes: 128 * 1024 * 1024
        });

        function invalidGif(message) {
            return new Error(`Invalid GIF: ${message}`);
        }

        function validateBudget(width, height, frameCount, overrides = {}) {
            const limits = { ...DEFAULT_LIMITS, ...overrides };
            if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
                throw invalidGif('logical screen dimensions must be positive integers');
            }
            if (width > limits.maxWidth || height > limits.maxHeight) {
                throw invalidGif(`dimensions ${width}×${height} exceed the ${limits.maxWidth}×${limits.maxHeight} maximum`);
            }
            if (!Number.isInteger(frameCount) || frameCount < 0) {
                throw invalidGif('frame count is invalid');
            }
            if (frameCount > limits.maxFrames) {
                throw invalidGif(`frame count ${frameCount} exceeds the ${limits.maxFrames} frame maximum`);
            }
            const pixels = width * height * frameCount;
            const decodedBytes = pixels * 4;
            if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(decodedBytes)) {
                throw invalidGif('decoded size exceeds safe browser limits');
            }
            if (decodedBytes > limits.maxDecodedBytes) {
                throw invalidGif(`decoded frame data requires ${Math.ceil(decodedBytes / (1024 * 1024))} MiB; maximum is ${Math.floor(limits.maxDecodedBytes / (1024 * 1024))} MiB`);
            }
            return { pixels, decodedBytes, limits };
        }

        // Binary stream reader
        class Stream {
            constructor(buf) {
                this.data = new Uint8Array(buf);
                this.pos = 0;
            }
            ensure(n, context = 'data') {
                if (!Number.isInteger(n) || n < 0 || this.pos + n > this.data.length) {
                    throw invalidGif(`truncated ${context} at byte ${this.pos}`);
                }
            }
            readByte(context = 'byte') {
                this.ensure(1, context);
                return this.data[this.pos++];
            }
            readBytes(n, context = 'data') {
                this.ensure(n, context);
                const s = this.data.slice(this.pos, this.pos + n);
                this.pos += n;
                return s;
            }
            readUint16(context = '16-bit value') {
                this.ensure(2, context);
                const v = this.data[this.pos] | (this.data[this.pos + 1] << 8);
                this.pos += 2;
                return v;
            }
            readString(n, context = 'string') {
                const bytes = this.readBytes(n, context);
                let s = '';
                for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
                return s;
            }
            skipBytes(n, context = 'data') {
                this.ensure(n, context);
                this.pos += n;
            }
        }

        function readSubBlocks(st, maxBytes = DEFAULT_LIMITS.maxSubBlockBytes) {
            const blocks = [];
            let totalLen = 0;
            while (true) {
                const size = st.readByte('sub-block size');
                if (size === 0) break;
                const block = st.readBytes(size, 'sub-block payload');
                blocks.push(block);
                totalLen += block.length;
                if (totalLen > maxBytes) {
                    throw invalidGif(`sub-block data exceeds the ${maxBytes} byte maximum`);
                }
            }
            const out = new Uint8Array(totalLen);
            let off = 0;
            blocks.forEach(b => { out.set(b, off); off += b.length; });
            return out;
        }

        function lzwDecode(minCodeSize, data, pixelCount) {
            if (!Number.isInteger(minCodeSize) || minCodeSize < 2 || minCodeSize > 8) {
                throw invalidGif(`LZW minimum code size ${minCodeSize} is outside 2–8`);
            }
            if (!Number.isInteger(pixelCount) || pixelCount < 1) {
                throw invalidGif('frame pixel count is invalid');
            }
            const clearCode = 1 << minCodeSize;
            const eoiCode = clearCode + 1;
            let codeSize = minCodeSize + 1;
            let codeMask = (1 << codeSize) - 1;
            let nextCode = eoiCode + 1;
            // Code table: each entry is Uint8Array of indices
            const table = new Array(4096);
            function initTable() {
                for (let i = 0; i < clearCode; i++) table[i] = new Uint8Array([i]);
                nextCode = eoiCode + 1;
                codeSize = minCodeSize + 1;
                codeMask = (1 << codeSize) - 1;
            }
            initTable();

            const pixels = new Uint8Array(pixelCount);
            let pixelPos = 0;
            let buf = 0, bufBits = 0, dataPos = 0;
            let prevCode = -1;

            function readCode() {
                while (bufBits < codeSize && dataPos < data.length) {
                    buf |= data[dataPos++] << bufBits;
                    bufBits += 8;
                }
                if (bufBits < codeSize) return null;
                const code = buf & codeMask;
                buf >>= codeSize;
                bufBits -= codeSize;
                return code;
            }

            while (true) {
                const code = readCode();
                if (code === null) throw invalidGif('truncated LZW image data');
                if (code === eoiCode) {
                    break;
                }
                if (code === clearCode) {
                    initTable();
                    prevCode = -1;
                    continue;
                }
                let entry;
                if (code < nextCode && table[code]) {
                    entry = table[code];
                } else if (code === nextCode && prevCode !== -1) {
                    const prev = table[prevCode];
                    entry = new Uint8Array(prev.length + 1);
                    entry.set(prev);
                    entry[prev.length] = prev[0];
                } else {
                    throw invalidGif(`invalid LZW code ${code}`);
                }
                if (pixelPos + entry.length > pixelCount) {
                    throw invalidGif('LZW data expands beyond the declared frame size');
                }
                pixels.set(entry, pixelPos);
                pixelPos += entry.length;
                if (prevCode !== -1 && nextCode < 4096) {
                    const prev = table[prevCode];
                    if (!prev) throw invalidGif('invalid LZW dictionary reference');
                    const newEntry = new Uint8Array(prev.length + 1);
                    newEntry.set(prev);
                    newEntry[prev.length] = entry[0];
                    table[nextCode++] = newEntry;
                    if (nextCode > codeMask && codeSize < 12) {
                        codeSize++;
                        codeMask = (1 << codeSize) - 1;
                    }
                }
                prevCode = code;
                if (pixelPos === pixelCount) break;
            }
            if (pixelPos !== pixelCount) {
                throw invalidGif(`LZW data produced ${pixelPos} of ${pixelCount} pixels`);
            }
            return pixels;
        }

        function deinterlace(pixels, width) {
            const height = Math.floor(pixels.length / width);
            const out = new Uint8Array(pixels.length);
            const passes = [
                { start: 0, step: 8 },
                { start: 4, step: 8 },
                { start: 2, step: 4 },
                { start: 1, step: 2 }
            ];
            let srcRow = 0;
            passes.forEach(p => {
                for (let row = p.start; row < height; row += p.step) {
                    out.set(pixels.slice(srcRow * width, (srcRow + 1) * width), row * width);
                    srcRow++;
                }
            });
            return out;
        }

        function parseGIF(buffer, limitOverrides = {}) {
            const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
            if (!buffer || !Number.isInteger(buffer.byteLength)) {
                throw invalidGif('input must be binary data');
            }
            if (buffer.byteLength > limits.maxInputBytes) {
                throw invalidGif(`input is ${buffer.byteLength} bytes; maximum is ${limits.maxInputBytes} bytes`);
            }
            const st = new Stream(buffer);
            const header = st.readString(6, 'header');
            if (header !== 'GIF89a' && header !== 'GIF87a') throw new Error('Not a GIF file');

            const width = st.readUint16('logical screen width');
            const height = st.readUint16('logical screen height');
            validateBudget(width, height, 0, limitOverrides);
            const packed = st.readByte('logical screen flags');
            const hasGCT = (packed >> 7) & 1;
            const gctSize = packed & 0x07;
            st.readByte('background color index');
            st.readByte('pixel aspect ratio');

            let gct = null;
            if (hasGCT) {
                const numColors = 2 << gctSize;
                gct = [];
                for (let i = 0; i < numColors; i++) {
                    gct.push([
                        st.readByte('global color table'),
                        st.readByte('global color table'),
                        st.readByte('global color table')
                    ]);
                }
            }

            const frames = [];
            let graphicControl = null;
            let sawTrailer = false;

            while (st.pos < st.data.length) {
                const block = st.readByte('block introducer');
                if (block === 0x3B) {
                    sawTrailer = true;
                    break;
                }
                if (block === 0x21) { // extension
                    const label = st.readByte('extension label');
                    if (label === 0xF9) { // graphic control
                        const blockSize = st.readByte('graphic control block size');
                        if (blockSize !== 4) throw invalidGif(`graphic control block size is ${blockSize}, expected 4`);
                        const gcp = st.readByte('graphic control flags');
                        const delay = st.readUint16('graphic control delay');
                        const transparentIndex = st.readByte('transparent color index');
                        const terminator = st.readByte('graphic control terminator');
                        if (terminator !== 0) throw invalidGif('graphic control extension is missing its terminator');
                        graphicControl = {
                            disposalMethod: (gcp >> 2) & 0x07,
                            transparentFlag: gcp & 0x01,
                            delay: delay,
                            transparentIndex: transparentIndex
                        };
                    } else {
                        // Skip other extensions
                        readSubBlocks(st, limits.maxSubBlockBytes);
                    }
                } else if (block === 0x2C) { // image descriptor
                    const left = st.readUint16('frame left offset');
                    const top = st.readUint16('frame top offset');
                    const fw = st.readUint16('frame width');
                    const fh = st.readUint16('frame height');
                    if (fw < 1 || fh < 1) throw invalidGif('frame dimensions must be positive');
                    if (left + fw > width || top + fh > height) {
                        throw invalidGif(`frame ${frames.length + 1} lies outside the logical screen`);
                    }
                    const idPacked = st.readByte('image descriptor flags');
                    const hasLCT = (idPacked >> 7) & 1;
                    const interlaced = (idPacked >> 6) & 1;
                    const lctSize = idPacked & 0x07;

                    let lct = null;
                    if (hasLCT) {
                        const numColors = 2 << lctSize;
                        lct = [];
                        for (let i = 0; i < numColors; i++) {
                            lct.push([
                                st.readByte('local color table'),
                                st.readByte('local color table'),
                                st.readByte('local color table')
                            ]);
                        }
                    }

                    const colorTable = lct || gct;
                    if (!colorTable) throw invalidGif(`frame ${frames.length + 1} has no color table`);
                    const minCodeSize = st.readByte('LZW minimum code size');
                    if (minCodeSize < 2 || minCodeSize > 8) {
                        throw invalidGif(`LZW minimum code size ${minCodeSize} is outside 2–8`);
                    }
                    const imageData = readSubBlocks(st, limits.maxSubBlockBytes);
                    if (imageData.length === 0) throw invalidGif(`frame ${frames.length + 1} has no image data`);

                    frames.push({
                        left, top, width: fw, height: fh,
                        interlaced: !!interlaced,
                        colorTable,
                        minCodeSize,
                        imageData,
                        graphicControl: graphicControl || null
                    });
                    validateBudget(width, height, frames.length, limitOverrides);
                    graphicControl = null;
                } else if (block === 0x00) {
                    // skip null block
                } else {
                    throw invalidGif(`unknown block 0x${block.toString(16).padStart(2, '0')} at byte ${st.pos - 1}`);
                }
            }

            if (!sawTrailer) throw invalidGif('missing trailer');
            if (frames.length === 0) throw invalidGif('contains no image frames');
            return { width, height, gct, frames };
        }

        function decompressFrames(gif, buildPatch) {
            return gif.frames.map(frame => {
                const { left, top, width, height, interlaced, colorTable, minCodeSize, imageData, graphicControl } = frame;
                const pixelCount = width * height;
                let pixels = lzwDecode(minCodeSize, imageData, pixelCount);
                if (interlaced) pixels = deinterlace(pixels, width);

                const gc = graphicControl || {};
                const transparentFlag = gc.transparentFlag || 0;
                const transparentIndex = gc.transparentIndex != null ? gc.transparentIndex : -1;
                const delay = gc.delay || 10; // centiseconds

                let patch = null;
                if (buildPatch && colorTable) {
                    patch = new Uint8ClampedArray(pixelCount * 4);
                    for (let i = 0; i < pixelCount; i++) {
                        const idx = pixels[i];
                        if (transparentFlag && idx === transparentIndex) {
                            patch[i*4] = 0; patch[i*4+1] = 0; patch[i*4+2] = 0; patch[i*4+3] = 0;
                        } else {
                            const color = colorTable[idx];
                            if (!color) throw invalidGif(`palette index ${idx} is outside the frame color table`);
                            patch[i*4] = color[0];
                            patch[i*4+1] = color[1];
                            patch[i*4+2] = color[2];
                            patch[i*4+3] = 255;
                        }
                    }
                }

                return {
                    patch,
                    dims: { left, top, width, height },
                    delay,
                    disposalType: gc.disposalMethod || 0,
                    transparentIndex: transparentFlag ? transparentIndex : -1
                };
            });
        }

        return { parseGIF, decompressFrames, validateBudget, limits: DEFAULT_LIMITS };
    })();
    // Alias to match gifuct-js API used in the app
    const gifuct = GifDecoder;
