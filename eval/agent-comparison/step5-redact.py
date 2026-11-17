"""Redact fixture pairing secrets before publishing, retaining private originals.

Usage: python3 step5-redact.py REPORT_PARENT PRIVATE_BACKUP AUDIT_JSON
Only step5 trial directories are scanned; measured counts/scores are unchanged.
"""
import hashlib,json,os,shutil,sys
from pathlib import Path
parent,backup,audit=map(Path,sys.argv[1:])
if audit.exists():raise FileExistsError('Refusing to overwrite an existing redaction audit')
backup.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(backup,0o700)
files=[p for root in sorted(parent.glob('luna-step5-*'))if root.is_dir()for p in root.rglob('*.json')if 'harness'not in p.parts]
secrets=set()
def visit(value):
 if isinstance(value,dict):
  arguments=value.get('arguments')
  if isinstance(arguments,dict)and(arguments.get('op')=='pair'or value.get('name')=='callisto_pair'):
   result=value.get('result');result=result if isinstance(result,dict)else{}
   for content in result.get('content')or[]:
    try:
     decoded=json.loads(content.get('text','{}'));code=decoded.get('code')
     if isinstance(code,str)and len(code)>20 and not code.startswith('[REDACTED'):secrets.add(code)
    except(ValueError,AttributeError,TypeError):pass
  for child in value.values():visit(child)
 elif isinstance(value,list):
  for child in value:visit(child)
for p in files:
 try:visit(json.loads(p.read_text()))
 except(ValueError,UnicodeError):pass
changed=[]
for p in files:
 original=p.read_bytes();text=original.decode();counts=0
 for secret in secrets:
  counts+=text.count(secret);text=text.replace(secret,'[REDACTED_EXPIRED_FIXTURE_PAIRING_CODE]')
 if not counts:continue
 destination=backup/p.relative_to(parent)
 if destination.exists():raise FileExistsError('Refusing to overwrite retained original '+str(destination))
 destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True);shutil.copyfile(p,destination);os.chmod(destination,0o600)
 replacement=text.encode();p.write_bytes(replacement)
 changed.append({'file':str(p.relative_to(parent)),'original_sha256':hashlib.sha256(original).hexdigest(),'published_sha256':hashlib.sha256(replacement).hexdigest(),'replacements':counts})
result={'schema':'callisto.fixture-secret-redaction.v1','reason':'Expired pairing codes from owned disposable relay sessions; no personal credentials. Native pair discovery calls remain counted.','replacement':'[REDACTED_EXPIRED_FIXTURE_PAIRING_CODE]','distinct_fixture_codes_redacted':len(secrets),'changes':changed,'measurements':'Original response_bytes, usage, elapsed times, scores and calls are preserved. Published text lengths differ. SHA256 of exact private originals is retained; raw originals remain in a private local backup.','private_backup':str(backup)}
audit.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'codes_redacted':len(secrets),'files_changed':len(changed),'replacements':sum(x['replacements']for x in changed)}))
