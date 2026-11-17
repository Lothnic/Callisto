import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BrowseFixture} from './browse-fixture.mjs';

test('legacy fresh sessions create before any replacement deletion',async()=>{
 const fixture=new BrowseFixture(),calls=[];
 fixture.apiMode='session';fixture.session='owned-fixture';
 fixture.client={callTool:async request=>{calls.push(request);return {};}};
 await fixture.configureOrigins(['https://example.com'],false);
 assert.deepEqual(calls,[{name:'session_new',arguments:{id:'owned-fixture',allowedOrigins:['https://example.com']}}]);
 calls.length=0;
 await fixture.configureOrigins(['https://example.org']);
 assert.deepEqual(calls.map(c=>c.name),['session_delete','session_new']);
 assert.equal(calls[0].arguments.id,'owned-fixture');
});

test('tab mode never calls removed session tools and resets its owned tab',async()=>{
 const fixture=new BrowseFixture(),calls=[];
 fixture.apiMode='tab';fixture.tab=123;
 fixture.client={callTool:async request=>{calls.push(request);return {};}};
 await fixture.configureOrigins(['https://example.com']);assert.deepEqual(calls,[]);
 await fixture.execute('return page.url()');
 assert.deepEqual(calls,[{name:'execute',arguments:{tab:123,code:'return page.url()'}}]);
});
