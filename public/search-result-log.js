self.installSearchResultLog = function (worker) {
    const resultClicks = new Map();
    self.addEventListener('message', event => {
        const data = event.data;
        if (data?.type !== 'search-result-redirect' || !event.source?.url ||
            new URL(event.source.url).origin !== location.origin || new URL(event.source.url).pathname !== '/') return;
        try {
            const url = new URL(data.url), source = new URL(data.source);
            if (url.href.length > 8192 || source.href.length > 8192 || url.origin !== source.origin ||
                source.pathname !== '/search' || !source.searchParams.get('q') || !['/url','/goto'].includes(url.pathname)) return;
            if (!self.webvpnSanitizeNavigationURL(source.href)?.search_query) return;
            const click = {source:self.webvpnSanitizeNavigationURL(source.href).url};
            if (resultClicks.size >= 256) resultClicks.delete(resultClicks.keys().next().value);
            resultClicks.set(url.href, click);
            setTimeout(() => { if (resultClicks.get(url.href) === click) resultClicks.delete(url.href); }, 60000);
        } catch { /* Unrecognized relay URL. */ }
    });

    function proxyTarget(value) {
        try {
            const url = new URL(value, location.origin);
            if (url.origin !== location.origin) return url.href;
            if (url.pathname.startsWith('/web/')) return decodeURIComponent(url.pathname.slice(5) + url.search);
            if (url.pathname === '/' && url.hash) return decodeURIComponent(url.hash.slice(1));
        } catch {}
        return '';
    }
    async function findResultSource(target) {
        const relay = new URL(target);
        if (!['/goto','/url'].includes(relay.pathname) ||
            !self.webvpnSanitizeNavigationURL(relay.origin + '/search?q=test')?.search_query) return;
        const tabs = (await self.clients.matchAll({type:'window'})).filter(client => {
            const current = new URL(client.url);
            return current.pathname === '/' && current.origin === location.origin;
        });
        const sources = await Promise.all(tabs.map(client => new Promise(resolve => {
            const channel = new MessageChannel();
            function done(value) { clearTimeout(timer); channel.port1.close(); resolve(value); }
            const timer = setTimeout(() => done(null), 700);
            channel.port1.onmessage = event => done(event.data);
            client.postMessage({type:'lookup-result-source', url:target}, [channel.port2]);
        })));
        const matches = new Set(sources.filter(value => value &&
            self.webvpnSanitizeNavigationURL(value)?.search_query && new URL(value).origin === relay.origin));
        if (matches.size === 1) return {source:[...matches][0]};
    }

    function rememberRelay(target, context) {
        if (!context || !target || target.length > 8192) return;
        const url = new URL(target);
        if (url.origin !== new URL(context.source).origin || !['/url','/goto'].includes(url.pathname)) return;
        if (resultClicks.size >= 256) resultClicks.delete(resultClicks.keys().next().value);
        resultClicks.set(target, context);
        setTimeout(() => { if (resultClicks.get(target) === context) resultClicks.delete(target); }, 60000);
    }

    function reportRedirect(context, value) {
        if (!context || !value || context.reported) return;
        const target = self.webvpnSanitizeNavigationURL(value);
        if (!target || new URL(target.url).origin === new URL(context.source).origin) return;
        context.reported = true;
        return fetch('/api/navigation-log', {method:'POST', credentials:'same-origin', keepalive:true,
            headers:{'Content-Type':'application/json'}, body:JSON.stringify({event_id:crypto.randomUUID(),
                source_url:context.source, target_url:target.url, source_relation:'search_result_click',
                url_redacted:target.redacted, client_timestamp:new Date().toISOString()})}).catch(() => {});
    }

    // Scramjet dispatches this event synchronously. Observe metadata only, then
    // do the lookup and reporting off the response path, without retaining its body.
    worker.addEventListener('handleResponse', event => {
        if (!['document', 'iframe'].includes(event.destination) ||
            event.status < 300 || event.status >= 400 ||
            !['/goto', '/url'].includes(event.url.pathname)) return;
        const relay = event.url.href;
        const locationHeader = event.rawResponse?.rawHeaders?.location ?? event.responseHeaders?.location;
        if (!locationHeader) return;
        let destination;
        try {
            const url = new URL(String(locationHeader), relay);
            destination = proxyTarget(url.href);
        } catch { return; }
        Promise.resolve().then(async () => {
            const context = resultClicks.get(relay) || await findResultSource(relay);
            if (!context) return;
            rememberRelay(destination, context);
            await reportRedirect(context, destination);
        }).catch(() => {});
    });
};
