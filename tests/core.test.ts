import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm,stat,appendFile,chmod} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {test} from "node:test";
import {acceptHeaderLine,previewTitle,tailName} from "../src/core/parse.ts";
import {clearScanCaches,filterByProject,getWarmSnapshot,listSessionPaths,readPreview,sameProjectPath,scanSessions} from "../src/core/scanner.ts";
import {findSessions,SessionSearchCache} from "../src/core/search.ts";
function fixture(id:string,cwd:string,text:string,name?:string){
  const lines=[
    JSON.stringify({type:"session",id,cwd,timestamp:"2026-10-23T00:00:00Z"}),
    JSON.stringify({type:"message",message:{role:"user",content:[{type:"text",text}]}}),
    JSON.stringify({type:"message",message:{role:"assistant",content:"reply"}})
  ];
  if(name!==undefined)lines.push(JSON.stringify({type:"session_info",name}));
  return lines.join("\n")+"\n";
}
test("header: extracts id, cwd and UTF-8 first message",()=>{
  const h={id:"",cwd:""};
  const l=fixture("a","C:/code","中文 test").split("\n");
  assert.equal(acceptHeaderLine(h,l[0]!),false);
  assert.equal(acceptHeaderLine(h,l[1]!),true);
  assert.equal(h.id,"a");
  assert.equal(previewTitle(h),"中文 test");
});
test("tail: latest name and explicit clear",()=>{
  const data=Buffer.from([JSON.stringify({type:"session_info",name:"old"}),
    JSON.stringify({type:"session_info",name:""})].join("\n"));
  assert.deepEqual(tailName(data,true),{found:true,name:undefined});
});
test("reader: handles long first message and later rename",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pi-resume-"));
  try{
    const path=join(dir,"a.jsonl");
    await writeFile(path,fixture("a",dir,"x".repeat(16400)+"你好","Renamed"));
    const s=await stat(path),p=await readPreview(path,s.mtimeMs,s.size);
    assert.equal(p?.title,"Renamed");
    assert.equal(p?.id,"a");
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("reader: large files do not require transcript parsing",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pi-resume-"));
  try{
    const path=join(dir,"big.jsonl");
    const row=JSON.stringify({type:"message",message:{role:"assistant",content:"x".repeat(20000)}})+"\n";
    await writeFile(path,fixture("big",dir,"hello")+row.repeat(250));
    const s=await stat(path);
    assert.ok(s.size>4*1024*1024);
    assert.equal((await readPreview(path,s.mtimeMs,s.size))?.title,"hello");
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("scanner: isolates broken files and filters custom directories",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pi-resume-"));
  try{
    const dir=join(root,"project");await mkdir(dir);
    await writeFile(join(dir,"2026-10-24.jsonl"),fixture("ok","/myproject","hello"));
    await writeFile(join(dir,"2026-10-23.jsonl"),fixture("other","/another","world"));
    await writeFile(join(dir,"bad.jsonl"),"broken");
    const ctrl=new AbortController(),ids:string[]=[];
    let complete=false;
    await scanSessions({root,currentDir:dir,scope:"current",cwd:"/myproject",
      filterCurrentByCwd:true,signal:ctrl.signal,onBatch:(batch,p)=>{
        ids.push(...batch.map(s=>s.id));complete=p.complete;
      }});
    assert.deepEqual(ids,["ok"]);
    assert.equal(complete,true);
    assert.equal((await listSessionPaths(root,"all",dir)).length,3);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("search: case-insensitive AND terms, stable original array",()=>{
  const sessions=[
    {path:"/a",id:"a",title:"Django worker",cwd:"/prj",size:1,modifiedMs:1},
    {path:"/b",id:"b",title:"worker Django",cwd:"/prj",size:1,modifiedMs:2},
    {path:"/c",id:"c",title:"Redis",cwd:"/prj",size:1,modifiedMs:3}
  ];
  assert.deepEqual(findSessions(sessions,"django worker").map(x=>x.id),["b","a"]);
  assert.equal(sessions[0]!.id,"a");
});
test("cancel: no batches after AbortController is stopped",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pi-resume-"));
  try{
    const dir=join(root,"dir");await mkdir(dir);
    await writeFile(join(dir,"a.jsonl"),fixture("a",dir,"hello"));
    const ctrl=new AbortController();let calls=0;
    await scanSessions({root,currentDir:dir,scope:"current",cwd:dir,signal:ctrl.signal,
      onBatch:()=>{calls++;ctrl.abort();}});
    assert.equal(calls,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("All scope streams the current folder before global discovery completes",async()=>{
  clearScanCaches();
  const root=await mkdtemp(join(tmpdir(),"pi-resume-stream-"));
  try{
    const current=join(root,"current");
    const other=join(root,"other");
    await mkdir(current);await mkdir(other);
    await writeFile(join(current,"a.jsonl"),fixture("a",current,"current"));
    await writeFile(join(other,"b.jsonl"),fixture("b",other,"other"));
    const updates:Array<{ids:string[];complete:boolean;total:number;loaded:number}>=[];
    await scanSessions({root,currentDir:current,scope:"all",cwd:current,
      signal:new AbortController().signal,
      onBatch:(rows,progress)=>updates.push({
        ids:rows.map(x=>x.id),complete:progress.complete,total:progress.total,loaded:progress.loaded
      })
    });
    const first=updates.find(x=>x.ids.includes("a"));
    assert.ok(first,"expected first current project batch");
    assert.equal(first.complete,false);
    assert.equal(first.loaded,1);
    assert.equal(first.total,1,"other project has not been enumerated yet");
    assert.ok(updates.some(x=>x.ids.includes("b")));
    assert.equal(updates.at(-1)?.complete,true);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("scan caches metadata, offers warm snapshot and invalidates after changes",async()=>{
  clearScanCaches();
  const root=await mkdtemp(join(tmpdir(),"pi-resume-cache-"));
  try{
    const dir=join(root,"project");await mkdir(dir);
    const file=join(dir,"one.jsonl");
    await writeFile(file,fixture("one",dir,"hello"));
    const options={root,currentDir:dir,scope:"current" as const,cwd:dir};
    const all:object[][]=[];
    for(let attempt=0;attempt<2;attempt++){
      const rows:object[]=[];
      await scanSessions({...options,signal:new AbortController().signal,
        onBatch:(batch)=>rows.push(...batch)
      });
      all.push(rows);
    }
    assert.equal(all[0]?.length,1);
    assert.strictEqual(all[0]?.[0],all[1]?.[0],"cache should reuse parsed metadata");
    assert.equal(getWarmSnapshot(options).length,1);
    await appendFile(file,JSON.stringify({type:"session_info",name:"New name"})+"\n");
    const rows:object[]=[];
    await scanSessions({...options,signal:new AbortController().signal,
      onBatch:(batch)=>rows.push(...batch)
    });
    assert.notStrictEqual(all[0]?.[0],rows[0],"file size change must invalidate cache");
    assert.equal((rows[0] as {title:string}).title,"New name");
  }finally{await rm(root,{recursive:true,force:true});clearScanCaches();}
});
test("cache snapshot excludes removed sessions after revalidation",async()=>{
  clearScanCaches();
  const root=await mkdtemp(join(tmpdir(),"pi-resume-stale-"));
  try{
    const dir=join(root,"project");await mkdir(dir);
    const file=join(dir,"gone.jsonl");await writeFile(file,fixture("gone",dir,"hello"));
    const options={root,currentDir:dir,scope:"current" as const,cwd:dir};
    await scanSessions({...options,signal:new AbortController().signal,onBatch:()=>{}});
    assert.equal(getWarmSnapshot(options).length,1);
    await rm(file);
    await scanSessions({...options,signal:new AbortController().signal,onBatch:()=>{}});
    assert.deepEqual(getWarmSnapshot(options),[]);
  }finally{await rm(root,{recursive:true,force:true});clearScanCaches();}
});
test("Windows path matching is case-insensitive, POSIX remains case-sensitive",()=>{
  assert.equal(sameProjectPath("C:\\Work\\Pi","c:\\work\\PI","win32"),true);
  assert.equal(sameProjectPath("/Work/Pi","/work/pi","linux"),false);
  const input=[{id:"a",path:"x",title:"test",cwd:"C:\\Work\\Pi",modifiedMs:0,size:1}];
  assert.equal(filterByProject(input,"c:\\work\\PI","win32").length,1);
});
test("search cache preserves results while the input and data are unchanged",()=>{
  const a={id:"a",path:"a",title:"Hello",cwd:"/work",modifiedMs:1,size:1};
  const b={id:"b",path:"b",title:"World",cwd:"/work",modifiedMs:2,size:1};
  const cache=new SessionSearchCache();
  cache.setSessions([a,b]);
  const first=cache.search("hello");
  assert.strictEqual(first,cache.search("hello"));
  assert.deepEqual(first.map(s=>s.id),["a"]);
  const different=cache.search("world");
  assert.notStrictEqual(first,different);
  cache.setSessions([b]);
  assert.notStrictEqual(different,cache.search("world"));
});
test("unreadable project directory is isolated when permissions are enforced",async(t)=>{
  if(process.platform==="win32"){t.skip("chmod does not reliably restrict Windows directories");return;}
  clearScanCaches();
  const root=await mkdtemp(join(tmpdir(),"pi-resume-permissions-"));
  const good=join(root,"good"),bad=join(root,"bad");
  try{
    await mkdir(good);await mkdir(bad);
    await writeFile(join(good,"ok.jsonl"),fixture("ok",good,"hello"));
    await writeFile(join(bad,"no.jsonl"),fixture("no",bad,"hello"));
    await chmod(bad,0o000);
    let enforce=false;
    try{await (await import("node:fs/promises")).opendir(bad);}
    catch{enforce=true;}
    if(!enforce){t.skip("test process bypasses directory permissions");return;}
    let sawGood=false,lastFailed=0;
    await scanSessions({root,currentDir:good,scope:"all",cwd:good,
      signal:new AbortController().signal,
      onBatch:(rows,p)=>{if(rows.some(r=>r.id==="ok"))sawGood=true;lastFailed=p.failed;}
    });
    assert.equal(sawGood,true);
    assert.ok(lastFailed>0,"directory failure must be counted without aborting other folders");
  }finally{await chmod(bad,0o700).catch(()=>{});await rm(root,{recursive:true,force:true});}
});
