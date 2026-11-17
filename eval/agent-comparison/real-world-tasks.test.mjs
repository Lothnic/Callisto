import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tasks,applyOracles,evaluate} from './real-world-tasks.mjs';

applyOracles({
 github:{title:"Suggestion: 'protected' modifier",state:'closed',author:'RyanCavanaugh'},
 pypi:{version:'0.28.1',requires_python:'>=3.8'},
 holidays:[{title:'Summer bank holiday',date:'2027-08-02'},{title:'St Andrew’s Day',date:'2027-11-30'}],
});
const cases=[
 ['wikipedia-biography','10 December 1815, London; mother Anne Isabella Milbanke.','https://en.wikipedia.org/wiki/Ada_Lovelace'],
 ['arxiv-paper','1706.03762; Ashish Vaswani and Noam Shazeer; 12 June 2017.','https://arxiv.org/abs/1706.03762'],
 ['github-issue',"Suggestion: 'protected' modifier; closed; RyanCavanaugh.",'https://github.com/microsoft/TypeScript/issues/1'],
 ['pypi-metadata','0.28.1; Python >=3.8.','https://pypi.org/project/httpx/'],
 ['python-json','JSONDecodeError; str, bytes, bytearray.','https://docs.python.org/3/library/json.html#json.loads'],
 ['govuk-calendar','Summer bank holiday: 2 August 2027. St Andrew’s Day: 30 November 2027.','https://www.gov.uk/bank-holidays'],
];
function sample(id,answer,url){return {task:tasks.find(t=>t.id===id),final:{answer,evidence:[{url,quote:answer}]},events:[{name:'callisto_snapshot',result:{content:[{type:'text',text:JSON.stringify({text:answer})}]}}]};}
for(const [id,answer,url] of cases){
 test(id+': facts, canonical source and a quote decoded from an MCP observation',()=>{
  const s=sample(id,answer,url);assert.equal(evaluate(s.task,s.final,s.events).passed,true);
  assert.equal(evaluate(s.task,{...s.final,answer:'Unknown'},s.events).passed,false);
  assert.equal(evaluate(s.task,{...s.final,evidence:[{url:'https://unrelated.example/',quote:answer}]},s.events).passed,false);
  assert.equal(evaluate(s.task,{...s.final,evidence:[{url,quote:'An invented quote never observed'}]},s.events).passed,false);
 });
}
test('known correct facts cannot bypass the browser with a direct request',()=>{
 const s=sample(...cases[0]);
 for(const code of ['return await fetch("https://example.com")','return await page.request.get("https://example.com")','return await files.read("answers.json")'])
  assert.equal(evaluate(s.task,s.final,[...s.events,{name:'execute',arguments:{code}}]).passed,false);
 assert.equal(evaluate(s.task,s.final,[...s.events,{name:'execute',arguments:{code:'return await page.locator("body").innerText()'}}]).passed,true);
});
test('calendar rejects the wrong date even with an observed source quote',()=>{
 const s=sample(...cases[5]);s.final.answer=s.final.answer.replace('2 August','3 August');assert.equal(evaluate(s.task,s.final,s.events).passed,false);
});

test('calendar accepts one explicit year shared by both dates and rejects the wrong year',()=>{
 const s=sample(...cases[5]);s.final.answer='In Scotland in 2027, summer bank holiday is Monday 2 August and St Andrew’s Day is Tuesday 30 November.';
 assert.equal(evaluate(s.task,s.final,s.events).passed,true);
 s.final.answer=s.final.answer.replace('2027','2026');assert.equal(evaluate(s.task,s.final,s.events).passed,false);
});

test('tab-wrapped JSON uses observed page values uniformly for either engine',()=>{
 const s=sample(...cases[3]);const quote='Requires\n\nPython >=3.8';
 s.final.evidence[0].quote=quote;
 const text='tab: 123\n\n'+JSON.stringify({text:quote})+'\n\nPage: 1 navigation';
 for(const name of ['execute','callisto']){
  const events=[{name,arguments:{},result:{content:[{type:'text',text}]}}];
  assert.equal(evaluate(s.task,s.final,events).passed,true);
  assert.equal(evaluate(s.task,{...s.final,evidence:[{...s.final.evidence[0],quote:'Requires Python >=3.9'}]},events).passed,false);
 }
});

test('decoded observation evidence still refuses direct API answers',()=>{
 const s=sample(...cases[3]);
 s.events[0].result.content[0].text='tab: 123\n\n'+JSON.stringify({text:s.final.answer});
 assert.equal(evaluate(s.task,s.final,[...s.events,{name:'execute',arguments:{code:'return await fetch("https://pypi.org/pypi/httpx/json")'}}]).passed,false);
});

test('native eval and compact Callisto replay obey the same no-direct-API policy',()=>{
 const s=sample(...cases[0]);
 for(const event of [
  {name:'eval',arguments:{expression:'return await fetch("https://example.com/api")'}},
  {name:'callisto',arguments:{op:'network',args:{action:'replay',url:'https://example.com'}}},
  {name:'callisto_network',arguments:{action:'replay',url:'https://example.com'}},
  {name:'callisto',arguments:{op:'input',args:{action:'disable'}}},
 ])assert.equal(evaluate(s.task,s.final,[...s.events,event]).passed,false);
 assert.equal(evaluate(s.task,s.final,[...s.events,{name:'eval',arguments:{expression:'document.body.innerText'}}]).passed,true);
});
