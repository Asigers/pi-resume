import {open,readdir,stat} from "node:fs/promises";
import {basename,join,resolve} from "node:path";
import {acceptHeaderLine,previewTitle,tailName,type HeaderInfo} from "./parse.ts";

export interface SessionPreview {
  path:string; id:string; title:string; cwd:string; modifiedMs:number; size:number; parentSession?:string;
}
export interface ScanProgress {loaded:number;total:number;failed:number;complete:boolean}
const READ_BLOCK = 16384;
const MAX_HEAD_BYTES = 2*1024*1024;
const TAIL_BYTES = 32768;
const BATCH = 24;

/** Partial reader: complete JSONL lines until first user entry, then a bounded tail. */
export async function readPreview(path:string,modifiedMs:number,size:number,signal?:AbortSignal):Promise<SessionPreview|null>{
  if(signal?.aborted || size<=0)return null;
  const fh=await open(path,"r");
  try {
    const header:HeaderInfo={id:"",cwd:""};
    let offset=0, pending=Buffer.alloc(0),found=false;
    while(!found && offset<size && offset<MAX_HEAD_BYTES && !signal?.aborted){
      const length=Math.min(READ_BLOCK,size-offset,MAX_HEAD_BYTES-offset);
      const buf=Buffer.allocUnsafe(length);
      const {bytesRead}=await fh.read(buf,0,length,offset);
      if(!bytesRead)break;
      offset+=bytesRead;
      const data=Buffer.concat([pending,buf.subarray(0,bytesRead)]);
      let begin=0,nl:number;
      while((nl=data.indexOf(10,begin))!==-1){
        if(acceptHeaderLine(header,data.toString("utf8",begin,nl))){found=true;break;}
        begin=nl+1;
      }
      pending=found?Buffer.alloc(0):Buffer.from(data.subarray(begin));
    }
    if(!found && pending.length && offset>=size)acceptHeaderLine(header,pending.toString("utf8"));
    if(!header.id || signal?.aborted)return null;
    // A recent /name entry is usually near EOF. Never parse the full file.
    const tailSize=Math.min(TAIL_BYTES,size);
    const tailStart=size-tailSize;
    const tail=Buffer.allocUnsafe(tailSize);
    const {bytesRead}=await fh.read(tail,0,tailSize,tailStart);
    const latest=tailName(tail.subarray(0,bytesRead),tailStart===0);
    if(latest.found)header.name=latest.name;
    return {path,id:header.id,title:previewTitle(header),cwd:header.cwd,
      parentSession:header.parentSession,modifiedMs,size};
  } finally {await fh.close();}
}
async function jsonlPaths(dir:string):Promise<string[]>{
  try {
    const entries=await readdir(dir,{withFileTypes:true});
    return entries.filter(e=>e.isFile()&&e.name.endsWith(".jsonl"))
      .map(e=>join(dir,e.name)).sort((a,b)=>basename(b).localeCompare(basename(a)));
  }catch(err){
    if((err as NodeJS.ErrnoException).code==="ENOENT")return [];
    throw err;
  }
}
export async function listSessionPaths(root:string,scope:"current"|"all",currentDir:string,
  signal?:AbortSignal,customDir=false):Promise<string[]>{
  if(scope==="current"||customDir)return jsonlPaths(currentDir);
  let dirs;
  try{dirs=await readdir(root,{withFileTypes:true});}
  catch(err){if((err as NodeJS.ErrnoException).code==="ENOENT")return [];throw err;}
  const paths:string[]=[];
  for(const dir of dirs){
    if(signal?.aborted)return [];
    if(dir.isDirectory())paths.push(...await jsonlPaths(join(root,dir.name)));
  }
  return paths.sort((a,b)=>basename(b).localeCompare(basename(a)));
}
export function filterByProject(sessions:SessionPreview[],cwd:string):SessionPreview[]{
  const expected=resolve(cwd);
  return sessions.filter(s=>Boolean(s.cwd)&&resolve(s.cwd)===expected);
}
/** Bounded, concurrent async batches; results of cancelled work are ignored. */
export async function scanSessions(options:{
 root:string; currentDir:string; scope:"current"|"all"; cwd:string; customDir?:boolean;
 filterCurrentByCwd?:boolean; signal:AbortSignal;
 onBatch:(batch:SessionPreview[],progress:ScanProgress)=>void
}):Promise<void>{
  const {root,currentDir,scope,cwd,signal,onBatch}=options;
  const paths=await listSessionPaths(root,scope,currentDir,signal,options.customDir);
  let loaded=0,failed=0;
  if(!signal.aborted)onBatch([],{loaded,total:paths.length,failed,complete:paths.length===0});
  for(let i=0;i<paths.length&&!signal.aborted;i+=BATCH){
    const group=paths.slice(i,i+BATCH);
    const results=await Promise.all(group.map(async path=>{
      try{
        const info=await stat(path);
        return info.isFile()&&!signal.aborted?await readPreview(path,info.mtimeMs,info.size,signal):null;
      }catch{return null;}
    }));
    if(signal.aborted)return;
    loaded+=group.length;
    failed+=results.filter(x=>!x).length;
    let batch=results.filter((x):x is SessionPreview=>x!==null);
    if(scope==="current"&&options.filterCurrentByCwd)batch=filterByProject(batch,cwd);
    onBatch(batch,{loaded,total:paths.length,failed,complete:loaded===paths.length});
  }
}
