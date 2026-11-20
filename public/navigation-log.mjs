import {sanitizeNavigationURL} from './navigation-policy.mjs';

export function sourceFromReferrer(referrer, origin) {
    try {
        const url = new URL(referrer);
        if (url.origin !== origin || !url.pathname.startsWith('/web/')) return null;
        return sanitizeNavigationURL(decodeURIComponent(url.pathname.slice(5) + url.search))?.url || null;
    } catch { return null; }
}

export function createNavigationReporter({send, initialSource = null, now = Date.now, uuid = () => crypto.randomUUID()} = {}) {
    let previous = sanitizeNavigationURL(initialSource)?.url || null;
    let lastKey = '', lastTime = 0;
    return {observe(value) {
        const target = sanitizeNavigationURL(value);
        if (!target) return;
        const key = target.url;
        // Controller may emit multiple events for the same loaded document.
        if (lastKey === key && now() - lastTime < 1500) return;
        const source = previous;
        previous = target.url; lastKey = key; lastTime = now();
        const report = {event_id:uuid(), target_url:target.url, source_url:source,
            client_timestamp:new Date(now()).toISOString(), url_redacted:target.redacted};
        // Failures must not interrupt browsing. No permanent queue or credential capture.
        Promise.resolve().then(() => send(report)).catch(() => {});
    }};
}

// Read the result link before Google replaces it with its outbound tracking URL.
export function externalResultURL(href, searchURL, portalOrigin) {
    if (!sanitizeNavigationURL(searchURL)?.search_query || !href) return null;
    try {
        let target = new URL(href, searchURL);
        if (target.origin === portalOrigin && target.pathname.startsWith('/web/'))
            target = new URL(decodeURIComponent(target.pathname.slice(5) + target.search));
        if (target.origin === new URL(searchURL).origin && target.pathname === '/url')
            target = new URL(target.searchParams.get('url') || target.searchParams.get('q'));
        if (target.origin === new URL(searchURL).origin || target.origin === portalOrigin) return null;
        return sanitizeNavigationURL(target.href);
    } catch { return null; }
}

function watchSearchResults(frame, send) {
    const watched = new WeakSet();
    function attach() {
        const doc = frame.contentDocument;
        if (!doc || watched.has(doc)) return;
        watched.add(doc);
        let pressed;
        function handle(event) {
            if (!event.isTrusted || event.button > 1) return;
            const link = event.target.closest?.('a[href]');
            if (!link || !link.querySelector('h3,[role="heading"]')) return;
            const source = sanitizeNavigationURL(decodeURIComponent(location.hash.slice(1)))?.url;
            if (!source || !sanitizeNavigationURL(source)?.search_query) return;
            const target = externalResultURL(link.href, source, location.origin);
            if (event.type === 'pointerdown') {
                pressed = {link, source, target, time:Date.now()};
                return;
            }
            const chosen = pressed?.link === link && pressed.source === source &&
                Date.now() - pressed.time < 10000 ? pressed.target || target : target;
            pressed = null;
            if (!chosen) {
                let redirect;
                try {
                    redirect = new URL(link.href, source);
                    if (redirect.origin === location.origin && redirect.pathname.startsWith('/web/'))
                        redirect = new URL(decodeURIComponent(redirect.pathname.slice(5) + redirect.search));
                } catch { return; }
                if (redirect.origin === new URL(source).origin && ['/url','/goto'].includes(redirect.pathname))
                    navigator.serviceWorker.controller?.postMessage({type:'search-result-redirect', url:redirect.href, source});
            }
            if (chosen) Promise.resolve(send({event_id:crypto.randomUUID(), target_url:chosen.url,
                source_url:source, source_relation:'search_result_click', url_redacted:chosen.redacted,
                client_timestamp:new Date().toISOString()})).catch(() => {});
        }
        for (const type of ['pointerdown','click','auxclick'])
            doc.addEventListener(type, handle, true);
    }
    // Search results are clickable while the document is still interactive.
    const timer = setInterval(() => {
        if (!frame.isConnected) return clearInterval(timer);
        if (document.visibilityState === 'visible') attach();
    }, 200);
    frame.addEventListener('load', attach);
    attach();
}

export async function startNavigationReporter() {
    try {
        const config = await fetch('/api/navigation-config', {credentials:'same-origin', cache:'no-store'});
        if (!config.ok || !(await config.json()).enabled) return {observe() {}};
        const send = body => fetch('/api/navigation-log', {method:'POST', credentials:'same-origin', cache:'no-store',
                headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), keepalive:true});
        return {...createNavigationReporter({initialSource:sourceFromReferrer(document.referrer, location.origin), send}),
            watchFrame: frame => watchSearchResults(frame, send)};
    } catch { return {observe() {}}; }
}
