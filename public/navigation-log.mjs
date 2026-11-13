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

export async function startNavigationReporter() {
    try {
        const config = await fetch('/api/navigation-config', {credentials:'same-origin', cache:'no-store'});
        if (!config.ok || !(await config.json()).enabled) return {observe() {}};
        return createNavigationReporter({
            initialSource:sourceFromReferrer(document.referrer, location.origin),
            send: body => fetch('/api/navigation-log', {method:'POST', credentials:'same-origin', cache:'no-store',
                headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), keepalive:true}),
        });
    } catch { return {observe() {}}; }
}
