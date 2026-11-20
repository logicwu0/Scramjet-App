import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {sanitizeNavigationURL} from '../public/navigation-policy.mjs';

test('click association logs a PDF redirect asynchronously without touching its body or headers', async () => {
    const portal = 'https://vpn.example';
    const source = 'https://www.google.com.hk/search?q=RFC2606';
    const relay = new URL('/goto?url=opaque', source);
    const target = 'https://dl.acm.org/doi/pdf/10.17487/RFC2606';
    const hooks = {}, reports = [];
    const self = {addEventListener:(name, fn) => hooks[name] = fn, webvpnSanitizeNavigationURL:sanitizeNavigationURL};
    const context = {self, location:new URL(portal), URL, crypto, setTimeout:()=>{},
        fetch:async (_,options) => {reports.push(JSON.parse(options.body)); throw Error('log collector unavailable');}};
    vm.runInNewContext(readFileSync(new URL('../public/search-result-log.js', import.meta.url),'utf8'), context);
    self.installSearchResultLog(self);
    hooks.message({data:{type:'search-result-redirect',url:relay.href,source},source:{url:portal+'/'}});
    const event = Object.freeze({url:relay, status:302, destination:'iframe',
        responseHeaders:Object.freeze({location:portal+'/web/'+encodeURIComponent(target+'?token=secret')}),
        get responseBody(){throw Error('logging read response body');}});
    assert.equal(hooks.handleResponse(event),undefined);
    assert.equal(reports.length,0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reports.length,1);
    assert.equal(reports[0].target_url,target);
    assert.equal(reports[0].source_url,source);
    assert.equal(reports[0].source_relation,'search_result_click');
});
