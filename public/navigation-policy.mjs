// Shared client/server policy. Unknown query values and all fragments are omitted.
const googleDomains = new Set(['google.com', 'google.com.hk', 'google.co.uk', 'google.com.tw', 'google.co.jp', 'google.de', 'google.fr', 'google.ca', 'google.com.au', 'google.co.in', 'google.com.sg']);
const contentKeys = new Set(['id', 'article', 'articleid', 'article_id', 'doi', 'page', 'p', 'start', 'offset', 'limit', 'lang', 'hl', 'q', 'query', 'search', 'keyword', 'keywords', 'v', 'tbm', 'udm']);
const sensitiveKey = /password|passwd|pwd|token|ticket|session|secret|credential|authorization|cookie|csrf|nonce|signature|assertion|saml|email|phone|auth|code|key/i;
const sensitivePath = /(?:^|\/)(?:auth|oauth2?|cas|login|signin|logout|signout|password|reset|reset-password|token|session|verify|verification|recaptcha)(?:\/|$)/i;
export function sanitizeNavigationURL(value) {
    if (typeof value !== 'string' || value.length > 8192) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const isGoogle = googleDomains.has(url.hostname.replace(/^www\./, ''));
    const rawSearch = isGoogle && url.pathname === '/search' ? url.searchParams.get('q') : null;
    const removed = new Set();
    let redacted = Boolean(url.username || url.password || url.hash);
    url.username = ''; url.password = ''; url.hash = '';
    if (sensitivePath.test(url.pathname) || /(?:accounts|mail)\.google\./i.test(url.hostname)) {
        url.pathname = '/[redacted]'; url.search = '';
        return {url:url.href, host:url.hostname, search_query:null, search_engine:null, redacted:true, omitted_parameters:[]};
    }
    const query = new URLSearchParams();
    for (const [key,val] of url.searchParams) {
        if (sensitiveKey.test(key) || !contentKeys.has(key.toLowerCase()) || val.length > 1000 || query.size >= 20) {
            if (removed.size < 20) removed.add(key.slice(0, 80));
            redacted = true;
            continue;
        }
        query.append(key,val.replace(/[\x00-\x1f\x7f]/g, ' '));
    }
    url.search = query.toString();
    return {url:url.href, host:url.hostname, search_query:rawSearch ? rawSearch.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,1000) : null,
        search_engine:rawSearch ? 'google' : null, redacted, omitted_parameters:[...removed]};
}
