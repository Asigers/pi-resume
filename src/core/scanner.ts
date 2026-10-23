import {open,opendir,stat} from "node:fs/promises";
import {join,posix,win32} from "node:path";
import {acceptHeaderLine,previewTitle,tailName,type HeaderInfo} from "./parse.ts";

export interface SessionPreview {
  path:string; id:string; title:string; cwd:string; modifiedMs:number; size:number; parentSession?:string;
}
export interface ScanProgress {
  loaded:number; total:number; failed:number; complete:boolean;
  /** All-scope discovery can still find more files; total grows while scanning. */
  discovering?:boolean;
}
export type Scope="current"|"all";
export interface ScanOptions {
  root:string; currentDir:string; scope:Scope; cwd:string; customDir?:boolean;
  filterCurrentByCwd?:boolean; signal:AbortSignal;
  onBatch:(batch:SessionPreview[],progress:ScanProgress)=>void;
}
const READ_BLOCK=16384;
const MAX_HEAD_BYTES=2*1024*1024;
const TAIL_BYTES=32768;
const BATCH=24;
const CACHE_LIMIT=8000;
const SNAPSHOT_LIMIT=16;
interface Cached {mtimeMs:number;size:number;preview:SessionPreview}
const previewCache=new Map<string,Cached>();
const snapshots=new Map<string,SessionPreview[]>();
export function clearScanCaches():void {previewCache.clear();snapshots.clear();}
export function sameProjectPath(a:string,b:string,platform:NodeJS.Platform=process.platform):boolean {
  const path=platform==="win32"?win32:posix;
  const left=path.resolve(a),right=path.resolve(b);
  return platform==="win32"?left.toLowerCase()===right.toLowerCase():left===right;
}
function cacheKey(o:Pick<ScanOptions,"root"|"currentDir"|"scope"|"cwd"|"customDir"|"filterCurrentByCwd">):string{
  return JSON.stringify([o.root,o.currentDir,o.scope,o.cwd,Boolean(o.customDir),Boolean(o.filterCurrentByCwd)]);
}
/** In-process, stale-while-revalidate snapshot for instant repeat openings. */
export function getWarmSnapshot(o:Pick<ScanOptions,"root"|"currentDir"|"scope"|"cwd"|"customDir"|"filterCurrentByCwd">):SessionPreview[]{
  return snapshots.get(cacheKey(o))?.slice()??[];
}
function saveSnapshot(key:string,previews:SessionPreview[]):void{
  snapshots.delete(key);
  snapshots.set(key,previews.slice());
  while(snapshots.size>SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!);
}
function storeCached(path:string,mtimeMs:number,size:number,preview:SessionPreview):void{
  previewCache.delete(path);
  previewCache.set(path,{mtimeMs,size,preview});
  while(previewCache.size>CACHE_LIMIT)previewCache.delete(previewCache.keys().next().value!);
}
async function cachedPreview(path:string,signal:AbortSignal):Promise<SessionPreview|null>{
  const info=await stat(path);
  if(!info.isFile()||signal.aborted)return null;
  const cached=previewCache.get(path);
  if(cached&&cached.size===info.size&&cached.mtimeMs===info.mtimeMs){
    previewCache.delete(path);previewCache.set(path,cached);
    return cached.preview;
  }
  previewCache.delete(path);
  const preview=await readPreview(path,info.mtimeMs,info.size,signal);
  if(preview&&!signal.aborted)storeCached(path,info.mtimeMs,info.size,preview);
  return preview;
}

/** Reads complete UTF-8 JSONL lines until the first user message, then a bounded tail. */
export async function readPreview(path:string,modifiedMs:number,size:number,signal?:AbortSignal):Promise<SessionPreview|null>{
  if(signal?.aborted||size<=0)return null;
  const fh=await open(path,"r");
  try{
    const header:HeaderInfo={id:"",cwd:""};
    let offset=0,pending=Buffer.alloc(0),found=false;
    while(!found&&offset<size&&offset<MAX_HEAD_BYTES&&!signal?.aborted){
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
    if(!found&&pending.length&&offset>=size)acceptHeaderLine(header,pending.toString("utf8"));
    if(!header.id||signal?.aborted)return null;
    const tailSize=Math.min(TAIL_BYTES,size),tailStart=size-tailSize;
    const tail=Buffer.allocUnsafe(tailSize);
    const {bytesRead}=await fh.read(tail,0,tailSize,tailStart);
    const latest=tailName(tail.subarray(0,bytesRead),tailStart===0);
    if(latest.found)header.name=latest.name;
    return {path,id:header.id,title:previewTitle(header),cwd:header.cwd,
      parentSession:header.parentSession,modifiedMs,size};
  }finally{await fh.close();}
}
type Discovery={paths:string[];directoryErrors:number};
/** Yield each directory incrementally; a single unreadable directory cannot stop All mode. */
async function* directoryChunks(dir:string,signal?:AbortSignal):AsyncGenerator<Discovery>{
  let handle;
  try{handle=await opendir(dir);}
  catch(err){
    if((err as NodeJS.ErrnoException).code!=="ENOENT")yield {paths:[],directoryErrors:1};
    return;
  }
  let pending:string[]=[];
  try{
    for await(const entry of handle){
      if(signal?.aborted)return;
      if(!entry.isFile()||!entry.name.endsWith(".jsonl"))continue;
      pending.push(join(dir,entry.name));
      if(pending.length===BATCH){
        yield {paths:pending,directoryErrors:0};
        pending=[];
      }
    }
  }catch(err){
    if(pending.length)yield {paths:pending,directoryErrors:0};
    if((err as NodeJS.ErrnoException).code!=="ENOENT")yield {paths:[],directoryErrors:1};
    return;
  }
  if(pending.length)yield {paths:pending,directoryErrors:0};
}
/** Open the current directory first, then discover other projects one directory at a time. */
async function* discover(root:string,scope:Scope,currentDir:string,signal?:AbortSignal,customDir=false):AsyncGenerator<Discovery>{
  yield* directoryChunks(currentDir,signal);
  if(scope==="current"||customDir||signal?.aborted)return;
  let handle;
  try{handle=await opendir(root);}
  catch(err){
    if((err as NodeJS.ErrnoException).code!=="ENOENT")yield {paths:[],directoryErrors:1};
    return;
  }
  try{
    for await(const entry of handle){
      if(signal?.aborted)return;
      if(!entry.isDirectory())continue;
      const dir=join(root,entry.name);
      if(sameProjectPath(dir,currentDir))continue;
      yield* directoryChunks(dir,signal);
    }
  }catch(err){
    if((err as NodeJS.ErrnoException).code!=="ENOENT")yield {paths:[],directoryErrors:1};
  }
}
/** Utility for diagnostics/tests. scanSessions does NOT wait for this whole list. */
export async function listSessionPaths(root:string,scope:Scope,currentDir:string,
 signal?:AbortSignal,customDir=false):Promise<string[]>{
  const paths:string[]=[];
  for await(const chunk of discover(root,scope,currentDir,signal,customDir))paths.push(...chunk.paths);
  return paths;
}
export function filterByProject(sessions:SessionPreview[],cwd:string,platform:NodeJS.Platform=process.platform):SessionPreview[]{
  return sessions.filter(s=>Boolean(s.cwd)&&sameProjectPath(s.cwd,cwd,platform));
}
/** Discovery, parse and rendering progress are interleaved across directory boundaries. */
export async function scanSessions(options:ScanOptions):Promise<void>{
  const {root,currentDir,scope,cwd,signal,onBatch}=options;
  let loaded=0,total=0,failed=0;
  const collected=new Map<string,SessionPreview>();
  if(signal.aborted)return;
  onBatch([],{loaded,total,failed,complete:false,discovering:true});
  for await(const discovery of discover(root,scope,currentDir,signal,options.customDir)){
    if(signal.aborted)return;
    total+=discovery.paths.length;
    failed+=discovery.directoryErrors;
    const batch=await Promise.all(discovery.paths.map(async path=>{
      try{return !signal.aborted?await cachedPreview(path,signal):null;}
      catch{return null;}
    }));
    if(signal.aborted)return;
    loaded+=discovery.paths.length;
    failed+=batch.filter(v=>v===null).length;
    let valid=batch.filter((v):v is SessionPreview=>v!==null);
    if(scope==="current"&&options.filterCurrentByCwd)valid=filterByProject(valid,cwd);
    for(const v of valid)collected.set(v.path,v);
    onBatch(valid,{loaded,total,failed,complete:false,discovering:true});
  }
  if(signal.aborted)return;
  if(failed===0)saveSnapshot(cacheKey(options),[...collected.values()]);
  onBatch([],{loaded,total,failed,complete:true,discovering:false});
}
