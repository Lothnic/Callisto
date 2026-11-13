import json,sys
from pathlib import Path
from webarena_verified import WebArenaVerified
from webarena_verified.types.tracing import NetworkTrace
p=Path('/tmp/callisto-wa-comparison')
name=sys.argv[1]
responses=json.loads((p/(name+'.json')).read_text())
ids=[11,41,62,94,107,112,183,193,198,208]
private=json.loads((p/'private.json').read_text())
for task in private:
    if any(e['evaluator']!='AgentResponseEvaluator' for e in task['eval']):
        raise ValueError('Refusing response-only scoring for a network-evaluated task')
by_id={int(r['task_id']):r for r in responses}
if set(by_id)!=set(ids) or len(responses)!=len(ids):raise ValueError('Expected exactly one result for each of the ten task IDs')
wa=WebArenaVerified(config=Path('/tmp/callisto-wa-config.json'))
empty=NetworkTrace(is_playwright=False,src_file=Path('NOT_RECORDED'),events=())
results=[]
for task_id in ids:
    x=by_id[task_id]
    answer={'task_type':'RETRIEVE','status':'SUCCESS' if x['status']=='SUCCESS' else 'UNKNOWN_ERROR','retrieved_data':x.get('retrieved_data',[]),'error_details':x.get('error')}
    r=wa.evaluate_task(task_id=task_id,agent_response=answer,network_trace=empty)
    results.append({'task_id':task_id,'agent_status':x['status'],'eval_status':str(r.status),'score':r.score,'elapsed_ms':x.get('elapsed_ms'),'tool_calls':x.get('tool_calls'),'error':x.get('error')})
(p/(name+'-scores.json')).write_text(json.dumps(results,indent=2))
print(json.dumps(results,indent=2))
