import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observationTextValues} from './observation-text.mjs';

test('native wrapped JSON retains exact decoded page quotes and original output',()=>{
 const quote='Requires\n\nPython >=3.8';
 const text='tab: 123\n\n'+JSON.stringify({text:quote})+'\n\nPage: 1 navigation';
 const values=observationTextValues({content:[{type:'text',text}]});
 assert.ok(values.includes(text));assert.ok(values.includes(quote));
 assert.ok(!values.includes('Requires Python >=3.9'));
});

test('plain JSON, arrays and unwrapped strings keep existing observation behavior',()=>{
 const text=JSON.stringify([{text:'Observed source quotation'}]);
 assert.ok(observationTextValues(text).includes('Observed source quotation'));
 assert.deepEqual(observationTextValues('plain text'),['plain text']);
});

test('arbitrary prose, malformed wrappers and error text are not decoded',()=>{
 for(const text of ['prose {"text":"invented"}','tab: nope\n\n{"text":"invented"}','tab: 123\n\nTimeoutError: failed', 'tab: 123\n\n{"text":"unfinished']){
  assert.deepEqual(observationTextValues(text),[text]);
 }
});
