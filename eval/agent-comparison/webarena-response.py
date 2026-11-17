"""Official WebArena Verified answer-only adapter; refuses network-evaluated tasks."""
import hashlib,json,sys
from pathlib import Path
from webarena_verified import WebArenaVerified
from webarena_verified.types.config import WebArenaVerifiedConfig
from webarena_verified.types.tracing import NetworkTrace
mode,task_id,origin=sys.argv[1],int(sys.argv[2]),sys.argv[3]
config=WebArenaVerifiedConfig(environments={'shopping_admin':{'urls':[origin],'use_header_login':True,'credentials':{'username':'admin','password':'admin1234'}}})
wa=WebArenaVerified(config=config);task=wa.get_task(task_id)
if not task.eval or any(e.evaluator!='AgentResponseEvaluator' for e in task.eval):
 raise ValueError('This adapter only scores official AgentResponseEvaluator tasks; network/live-judge tasks require their real evaluator inputs')
if mode=='describe':
 print(json.dumps({'task_id':task.task_id,'intent':task.intent,'start_urls':task.start_urls,'results_schemas':[e.model_dump(mode='json')['results_schema'] for e in task.eval],'evaluator_version':'1.2.3','dataset_sha256':hashlib.sha256(config.test_data_file.read_bytes()).hexdigest()}))
elif mode=='score':
 response=json.loads(Path(sys.argv[4]).read_text())
 trace=NetworkTrace(is_playwright=False,src_file=Path('NOT_RECORDED_ANSWER_ONLY_TASK'),events=())
 result=wa.evaluate_task(task_id=task_id,agent_response=response,network_trace=trace)
 print(result.model_dump_json())
else:raise ValueError('Expected describe or score')
