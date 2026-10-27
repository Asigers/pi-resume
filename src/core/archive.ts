import {randomUUID} from "node:crypto";
import {mkdir,readFile,rename,unlink,writeFile} from "node:fs/promises";
import {dirname,join,posix,win32} from "node:path";

/** Archive metadata is separate from Pi's JSONL files. Native /resume is unaffected. */
interface ArchiveIndex {version:1;paths:string[]}

export function archivePathKey(path:string,platform:NodeJS.Platform=process.platform):string{
  const lib=platform==="win32"?win32:posix;
  const resolved=lib.resolve(path);
  return platform==="win32"?resolved.toLowerCase():resolved;
}

export function filterArchiveSessions<T extends {path:string}>(
  sessions:T[],isArchived:(path:string)=>boolean,archived:boolean
):T[]{
  return sessions.filter(s=>isArchived(s.path)===archived);
}

export class ArchiveStore {
  private entries=new Set<string>();
  constructor(readonly file:string){}

  private async readIndex():Promise<Set<string>>{
    let raw:unknown;
    try{raw=JSON.parse(await readFile(this.file,"utf8")) as unknown;}
    catch(err){
      if((err as NodeJS.ErrnoException).code==="ENOENT")return new Set();
      if(err instanceof SyntaxError)throw new Error("Invalid archive index JSON: "+this.file);
      throw err;
    }
    if(!raw||typeof raw!=="object"||Array.isArray(raw)||
      (raw as Partial<ArchiveIndex>).version!==1||
      !Array.isArray((raw as Partial<ArchiveIndex>).paths)||
      !(raw as ArchiveIndex).paths.every(p=>typeof p==="string")){
      throw new Error("Unsupported or damaged archive index: "+this.file);
    }
    return new Set((raw as ArchiveIndex).paths.map(p=>archivePathKey(p)));
  }

  async load():Promise<void>{
    this.entries=await this.readIndex();
  }
  isArchived(path:string):boolean{
    return this.entries.has(archivePathKey(path));
  }

  /** Atomic index replacement; never writes, renames, or deletes session transcripts. */
  async setArchived(path:string,archived:boolean):Promise<void>{
    // Re-read to preserve changes from other Pi processes between picker openings.
    const next=await this.readIndex();
    const key=archivePathKey(path);
    const previous=next.has(key);
    if(previous===archived){this.entries=next;return;}
    if(archived)next.add(key);
    else next.delete(key);
    const folder=dirname(this.file);
    await mkdir(folder,{recursive:true});
    const temporary=join(folder,".archive-"+process.pid+"-"+randomUUID()+".tmp");
    const index:ArchiveIndex={version:1,paths:[...next].sort()};
    try{
      await writeFile(temporary,JSON.stringify(index,null,2)+"\n",
        {encoding:"utf8",mode:0o600,flag:"wx"});
      await rename(temporary,this.file);
    }finally{
      await unlink(temporary).catch(()=>{});
    }
    this.entries=next;
  }
}
