import fs from 'node:fs';
import vm from 'node:vm';

export function readInlineScripts() {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1]);
}

export function readSourceScripts() {
  return [
    ['gif-decoder.js'],
    ['gif-encoder.js'],
    ['history-controller.js', 'recovery-controller.js', 'export-controller.js', 'app.js']
  ].map(filenames => filenames
    .map(filename => fs.readFileSync(new URL('../src/' + filename, import.meta.url), 'utf8')
      .replace(/^export\s+/gm, '')
      .trimEnd())
    .join('\n\n'));
}

export function loadGifDecoder() {
  const [decoderSource] = readSourceScripts();
  if (!decoderSource?.includes('const GifDecoder')) {
    throw new Error('GifDecoder source boundary was not found');
  }
  const context = vm.createContext({});
  new vm.Script(`${decoderSource}\nglobalThis.__gifDecoder = GifDecoder;`, {
    filename: 'src/gif-decoder.js'
  }).runInContext(context);
  return context.__gifDecoder;
}
