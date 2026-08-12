/*! GifStudio service worker; COOP/COEP behavior derived from coi-serviceworker (MIT). */
const APP_VERSION = '0.6.0';
const CACHE_NAME = `gifstudio-v${APP_VERSION}`;
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './icon.png',
    './icons/icon-192.png',
    './icons/icon-192-maskable.png',
    './icons/icon-512.png',
    './icons/icon-512-maskable.png',
    './vendor/pako-2.1.0.min.js',
    './vendor/upng-2.1.0.js',
    './vendor/gifsicle-wasm-browser-1.5.19.min.js'
];

function withIsolationHeaders(response) {
    if (!response || response.status === 0) return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

async function notifyClients(type) {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client => client.postMessage({ type, version: APP_VERSION }));
}

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter(name => name.startsWith('gifstudio-v') && name !== CACHE_NAME)
            .map(name => caches.delete(name)));
        await self.clients.claim();
        await notifyClients('GIFSTUDIO_SW_ACTIVATED');
    })());
});

self.addEventListener('message', event => {
    if (event.data?.type === 'GIFSTUDIO_SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request, { ignoreSearch: true });
        const isNavigation = request.mode === 'navigate';

        if (!isNavigation && cached) {
            event.waitUntil(fetch(request)
                .then(response => {
                    if (response.ok) return cache.put(request, response.clone());
                })
                .catch(() => {}));
            return withIsolationHeaders(cached);
        }

        try {
            const response = await fetch(request);
            if (response.ok) await cache.put(request, response.clone());
            return withIsolationHeaders(response);
        } catch {
            if (cached) return withIsolationHeaders(cached);
            if (isNavigation) {
                const fallback = await cache.match('./index.html');
                if (fallback) return withIsolationHeaders(fallback);
            }
            return withIsolationHeaders(new Response('GifStudio is offline and this asset is not cached.', {
                status: 503,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            }));
        }
    })());
});
