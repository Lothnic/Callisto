import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export async function provenance(){
 const {stdout:revision}=await exec('git',['rev-parse','HEAD']);
 const {stdout:changes}=await exec('git',['status','--porcelain','--','packages/firefox-rs','packages/mini','scripts','eval/agent-comparison']);
 return {source_revision:revision.trim(),working_tree_dirty:!!changes.trim()};
}
