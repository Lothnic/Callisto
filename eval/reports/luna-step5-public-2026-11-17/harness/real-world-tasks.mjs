import {observationTextValues as textValues} from './observation-text.mjs';
import {policyViolations} from './policy-audit.mjs';
// Public, read-only tasks. Expected answers are evaluator-only, never in prompts.
export const tasks = [
 {id:'wikipedia-biography',name:'Wikipedia biography',start:'https://en.wikipedia.org/wiki/Main_Page',origins:['https://en.wikipedia.org'],instruction:'Find Ada Lovelace on Wikipedia. Report her full birth date, birthplace and mother’s name. Cite the biography page and a short supporting quote.',expected:{date:'10 December 1815',place:'London',mother:'Anne Isabella Milbanke'},checks:[/10\s+December\s+1815|December\s+10,?\s+1815|1815-12-10/i,/London/i,/(?:Annabella|Anne?\s+Isabella)(?:\s+Noel)?\s+(?:Milbanke|Byron)/i],source:/en\.wikipedia\.org\/wiki\/Ada_Lovelace/i},
 {id:'arxiv-paper',name:'arXiv paper lookup',start:'https://arxiv.org/',origins:['https://arxiv.org'],instruction:'Find the paper titled exactly “Attention Is All You Need” on arXiv. Report its arXiv identifier, first two authors and original submission date. Cite the abstract page and a short supporting quote.',expected:{id:'1706.03762',authors:['Ashish Vaswani','Noam Shazeer'],date:'12 June 2017'},checks:[/1706\.03762/,/Ashish\s+Vaswani/i,/Noam\s+Shazeer/i,/12\s+Jun(?:e)?\s+2017|Jun(?:e)?\s+12,?\s+2017|2017-06-12/i],source:/arxiv\.org\/abs\/1706\.03762/i},
 {id:'github-issue',name:'GitHub issue lookup',start:'https://github.com/microsoft/TypeScript',origins:['https://github.com'],instruction:'Find issue #1 in microsoft/TypeScript on GitHub. Report its title, whether it is open or closed, and the username of the person who opened it. Cite the issue page and a short supporting quote.',oracle:'github',checks:[],source:/github\.com\/microsoft\/TypeScript\/issues\/1(?:\b|#)/i},
 {id:'pypi-metadata',name:'PyPI package metadata',start:'https://pypi.org/project/httpx/',origins:['https://pypi.org'],instruction:'On PyPI, inspect the httpx project and its release history. Report the latest stable release version and its minimum required Python version. Cite the project page and a short supporting quote.',oracle:'pypi',checks:[],source:/pypi\.org\/project\/httpx\//i},
 {id:'python-json',name:'Python documentation',start:'https://docs.python.org/3/',origins:['https://docs.python.org'],instruction:'Find the Python documentation for json.loads. Report the exception raised for invalid JSON and the supported types of its input argument s. Cite the relevant documentation page and a short supporting quote.',expected:{error:'JSONDecodeError',inputs:['str','bytes','bytearray']},checks:[/JSONDecodeError/,/\bstr\b|string/i,/\bbytes\b/,/\bbytearray\b/],source:/docs\.python\.org\/3(?:\.\d+)?\/library\/json\.html/i},
 {id:'govuk-calendar',name:'GOV.UK holiday calendar',start:'https://www.gov.uk/bank-holidays',origins:['https://www.gov.uk'],instruction:'Use the GOV.UK bank holiday calendar for Scotland in 2027. Report the dates of the summer bank holiday and St Andrew’s Day. Cite the calendar page and a short supporting quote.',oracle:'holidays',checks:[],source:/gov\.uk\/bank-holidays/i},
];
export const normalize = value => String(value).normalize('NFKC').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\s+/g,' ').trim().toLowerCase();
function datePattern(date){
 const [year,month,day]=date.split('-');
 const name=['January','February','March','April','May','June','July','August','September','October','November','December'][Number(month)-1];
 const number=`\\b${Number(day)}(?:st|nd|rd|th)?\\b`;
 return new RegExp(`${number}\\s+${name}\\b(?:\\s+${year}\\b)?|\\b${name}\\s+${number}(?:,?\\s+${year}\\b)?|\\b${date}\\b`,'i');
}
export function applyOracles(oracles){
 for(const task of tasks){
  if(task.oracle==='github'){const x=oracles.github;task.expected=x;task.checks=[/Suggestion.{0,10}protected.{0,10}modifier/i,new RegExp(x.state,'i'),new RegExp(x.author,'i')];}
  if(task.oracle==='pypi'){const x=oracles.pypi;task.expected=x;task.checks=[new RegExp(x.version.replaceAll('.','\\.')),new RegExp(x.requires_python.replace(/^[^\d]+/, '').replaceAll('.','\\.'))];}
  if(task.oracle==='holidays'){task.expected=oracles.holidays;task.checks=[/\b2027\b/,...oracles.holidays.map(x=>datePattern(x.date))];}
 }
 return tasks;
}
export function evaluate(task,final,events){
 const answer=String(final?.answer||'');const sources=Array.isArray(final?.evidence)?final.evidence:[];
 const facts=task.checks.map(check=>({pattern:check.source,passed:check.test(answer)}));
 // Check an exact supporting quote against text actually returned to the host.
 const observed=normalize(events.flatMap(e=>textValues(e.result)).join(' '));
 const evidence=sources.map(s=>({url:s.url,quote:s.quote,source_matches:task.source.test(String(s.url)),quote_observed:normalize(s.quote).length>=12&&observed.includes(normalize(s.quote))}));
 const forbidden=policyViolations(events);
 return {passed:facts.every(f=>f.passed)&&evidence.some(e=>e.source_matches&&e.quote_observed)&&forbidden.length===0,facts,evidence,forbidden_network_or_file_calls:forbidden.length};
}
