import fs from 'node:fs';
import vm from 'node:vm';

export function readInlineScripts() {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1]);
}

export function loadGifDecoder() {
  const [decoderSource] = readInlineScripts();
  if (!decoderSource?.includes('const GifDecoder')) {
    throw new Error('GifDecoder inline script was not found');
  }
  const context = vm.createContext({});
  new vm.Script(`${decoderSource}\nglobalThis.__gifDecoder = GifDecoder;`, {
    filename: 'index.html#gif-decoder'
  }).runInContext(context);
  return context.__gifDecoder;
}
