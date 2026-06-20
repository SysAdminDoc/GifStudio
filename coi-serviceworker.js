/*! coi-serviceworker - Guido Zuidhof, licensed under MIT */
/*  Injects COOP/COEP headers via service worker interception.       */
/*  Enables SharedArrayBuffer on static hosting (GitHub Pages, etc). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
    if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
    e.respondWith(
        fetch(e.request).then((r) => {
            if (r.status === 0) return r;
            const headers = new Headers(r.headers);
            headers.set("Cross-Origin-Embedder-Policy", "credentialless");
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
        }).catch((err) => console.error(err))
    );
});
