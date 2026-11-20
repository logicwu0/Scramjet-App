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

function watchSearchResults(frame, send, remember) {
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
                    remember(redirect.href, source);
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

// A popup starts with the exact Google relay in the portal hash. Exchange only
// its digest between tabs. Clicks expire in memory and never change the link.
function connectResultTabs(send) {
    const clicks = new Map();
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('webvpn-result-click-v1') : null;
    const nonce = crypto.randomUUID();
    let active = null;
    let timer;
    async function digest(url) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
        return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
    }
    function report() {
        if (!active?.target || !active.source) return;
        const {source,target} = active;
        active = null;
        clearTimeout(timer);
        void send({event_id:crypto.randomUUID(), target_url:target.url, source_url:source,
            source_relation:'search_result_click', url_redacted:target.redacted,
            client_timestamp:new Date().toISOString()}).catch(() => {});
    }
    if (channel) channel.onmessage = ({data}) => {
        if (data?.type === 'lookup') {
            const source = clicks.get(data.key);
            if (source) channel.postMessage({type:'found',key:data.key,source,nonce:data.nonce});
        } else if (data?.type === 'found' && active?.key === data.key && data.nonce === nonce &&
                   sanitizeNavigationURL(data.source)?.search_query && new URL(data.source).origin === active.origin) {
            active.source = data.source;
            report();
        }
    };
    function remember(url, source) {
        void digest(url).then(key => {
            if (clicks.size >= 64) clicks.delete(clicks.keys().next().value);
            clicks.set(key,source);
            setTimeout(() => clicks.delete(key),60000);
        }).catch(() => {});
    }
    function observe(value) {
        if (!value) return;
        let url;
        try { url = new URL(value); } catch { return; }
        if (['/url','/goto'].includes(url.pathname) && sanitizeNavigationURL(url.origin+'/search?q=x')?.search_query) {
            if (active?.url === url.href) return;
            const pending = active = {url:url.href,origin:url.origin};
            clearTimeout(timer);
            timer = setTimeout(() => {active=null;},60000);
            void digest(url.href).then(key => {
                if (active !== pending) return;
                pending.key = key;
                pending.source = clicks.get(key);
                channel?.postMessage({type:'lookup',key,nonce});
                report();
            }).catch(() => {});
        } else if (active && url.origin !== active.origin) {
            active.target ??= sanitizeNavigationURL(value);
            report();
        } else if (sanitizeNavigationURL(value)?.search_query) {
            active = null;
        }
    }
    try { observe(decodeURIComponent(location.hash.slice(1))); } catch {}
    return {remember, observe};
}

export async function startNavigationReporter() {
    try {
        const config = await fetch('/api/navigation-config', {credentials:'same-origin', cache:'no-store'});
        if (!config.ok || !(await config.json()).enabled) return {observe() {}};
        const send = body => fetch('/api/navigation-log', {method:'POST', credentials:'same-origin', cache:'no-store',
                headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), keepalive:true});
        const relay = connectResultTabs(send);
        const frames = new WeakSet();
        function attachFrame() {
            const frame = document.getElementById('sj-frame');
            if (!frame || frames.has(frame)) return;
            frames.add(frame);
            watchSearchResults(frame, send, relay.remember);
            frame.addEventListener('load', () => {
                try {
                    const loaded = new URL(frame.contentWindow.location.href);
                    if (loaded.origin === location.origin && loaded.pathname.startsWith('/web/'))
                        relay.observe(decodeURIComponent(loaded.pathname.slice(5) + loaded.search));
                } catch {}
            });
        }
        new MutationObserver(attachFrame).observe(document.body, {childList:true});
        attachFrame();
        const navigation = createNavigationReporter({initialSource:sourceFromReferrer(document.referrer, location.origin), send});
        return {observe(url) { navigation.observe(url); relay.observe(url); }};
    } catch { return {observe() {}}; }
}
