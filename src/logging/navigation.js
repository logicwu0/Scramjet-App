import {appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {sanitizeNavigationURL} from '../../public/navigation-policy.mjs';

export function registerNavigationLogging(app, auth, origin, {
    enabled = process.env.NAVIGATION_LOG_ENABLED === '1',
    file = process.env.ACCESS_LOG_FILE,
    write = appendFileSync, now = Date.now,
} = {}) {
    const seen = new Map(), rates = new Map();
    const active = enabled && Boolean(file);
    app.get('/api/navigation-config', async (req, reply) => {
        if (!auth.accessContext(req.raw)) return reply.code(401).send({error:'login_required'});
        return {enabled:active};
    });
    app.post('/api/navigation-log', {bodyLimit:24000}, async (req,reply) => {
        const identity = auth.accessContext(req.raw);
        if (!identity) return reply.code(401).send({error:'login_required'});
        if (req.headers.origin !== origin) return reply.code(403).send();
        if (!active) return reply.code(204).send();
        const body=req.body;
        if (!body || typeof body !== 'object' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.event_id || '')) return reply.code(400).send();
        const target=sanitizeNavigationURL(body.target_url), source=sanitizeNavigationURL(body.source_url);
        if (!target) return reply.code(400).send();
        const time=now(), actor=identity.account;
        for (const [key,value] of rates) if (time-value.start >= 60000) rates.delete(key);
        for (const [key,value] of seen) if (time-value >= 300000) seen.delete(key);
        if (!rates.has(actor)) {
            if (rates.size>=2000) return reply.code(429).send();
            rates.set(actor,{start:time,count:0});
        }
        if (++rates.get(actor).count>120) return reply.code(429).send();
        const dedup=actor+':'+body.event_id;
        if (seen.has(dedup)) return reply.code(204).send();
        if (seen.size>=10000) seen.delete(seen.keys().next().value);
        const clientTime=typeof body.client_timestamp==='string' && body.client_timestamp.length<50 ? Date.parse(body.client_timestamp) : NaN;
        const row={timestamp:new Date(time).toISOString(), event_id:randomUUID(), category:'access',
            record_type:'navigation', evidence_source:'browser_report', result:'observed',
            account:identity.account, source_ip:identity.sourceIp,
            target_host:target.host, target_url:target.url, source_url:source?.url || null,
            search_engine:target.search_engine, search_query:target.search_query,
            source_search_query:source?.search_query || null,
            source_relation:source ? 'previous_page_inferred' : 'unknown',
            url_redacted:target.redacted || body.url_redacted===true,
            client_timestamp:Number.isFinite(clientTime)?new Date(clientTime).toISOString():null};
        try { write(file,JSON.stringify(row)+'\n',{encoding:'utf8',mode:0o640}); }
        catch { return reply.code(503).send({error:'navigation_log_unavailable'}); }
        seen.set(dedup,time);
        return reply.code(204).send();
    });
}
