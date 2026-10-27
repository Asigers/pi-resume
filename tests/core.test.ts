import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm,stat,appendFile,chmod} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {test} from "node:test";
import {acceptHeaderLine,previewTitle,tailName} from "../src/core/parse.ts";
import {clearScanCaches,filterByProject,getWarmSnapshot,listSessionPaths,readPreview,sameProjectPath,scanSessions} from "../src/core/scanner.ts";
import {findSessions,SessionSearchCache} from "../src/core/search.ts";
import {buildSessionTree,isActiveSession,treePrefix} from "../src/core/tree.ts";
import {ArchiveStore,archivePathKey,filterArchiveSessions} from "../src/core/archive.ts";
import {moveSessionToTrash} from "../src/core/trash.ts";
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

test("threaded picker keeps fork children and grandchildren next to their parent",()=>{
  const s=[
    {id:"fork",path:"/work/fork.jsonl",title:"Fork",cwd:"/work",modifiedMs:500,size:1,parentSession:"/work/main.jsonl"},
    {id:"other",path:"/work/other.jsonl",title:"Other",cwd:"/work",modifiedMs:400,size:1},
    {id:"grand",path:"/work/grand.jsonl",title:"Nested",cwd:"/work",modifiedMs:300,size:1,parentSession:"/work/fork.jsonl"},
    {id:"main",path:"/work/main.jsonl",title:"Main",cwd:"/work",modifiedMs:200,size:1},
    {id:"fork2",path:"/work/fork2.jsonl",title:"Another fork",cwd:"/work",modifiedMs:100,size:1,parentSession:"/work/main.jsonl"}
  ];
  const tree=buildSessionTree(s,"linux");
  assert.deepEqual(tree.map(row=>row.session.id),["other","main","fork","grand","fork2"]);
  assert.deepEqual(tree.map(row=>row.depth),[0,0,1,2,1]);
  assert.equal(treePrefix(tree[2]!),"├─ ");
  assert.equal(treePrefix(tree[3]!),"│  └─ ");
  assert.equal(treePrefix(tree[4]!),"└─ ");
});
test("an orphaned child attaches when its parent is loaded asynchronously",()=>{
  const child={id:"child",path:"/work/child.jsonl",title:"Child",cwd:"/work",modifiedMs:8,size:1,parentSession:"/work/parent.jsonl"};
  assert.equal(treePrefix(buildSessionTree([child],"linux")[0]!),"↳ ");
  const parent={id:"parent",path:"/work/parent.jsonl",title:"Parent",cwd:"/work",modifiedMs:7,size:1};
  const tree=buildSessionTree([child,parent],"linux");
  assert.deepEqual(tree.map(r=>r.session.id),["parent","child"]);
  assert.equal(tree[1]!.depth,1);
});
test("malformed cyclic and self-referential parent paths remain visible",()=>{
  const s=[
    {id:"a",path:"/p/a",title:"A",cwd:"/p",modifiedMs:1,size:1,parentSession:"/p/b"},
    {id:"b",path:"/p/b",title:"B",cwd:"/p",modifiedMs:2,size:1,parentSession:"/p/a"},
    {id:"self",path:"/p/c",title:"C",cwd:"/p",modifiedMs:3,size:1,parentSession:"/p/c"}
  ];
  const rows=buildSessionTree(s,"linux");
  assert.equal(rows.length,3);
  assert.deepEqual(new Set(rows.map(x=>x.session.id)),new Set(["a","b","self"]));
});
test("Windows parent linkage and current-session paths ignore filename case",()=>{
  const s=[
    {id:"child",path:"C:\\Work\\Child.jsonl",title:"Child",cwd:"C:\\Work",modifiedMs:2,size:1,parentSession:"c:\\work\\PARENT.jsonl"},
    {id:"parent",path:"C:\\WORK\\parent.jsonl",title:"Parent",cwd:"C:\\Work",modifiedMs:1,size:1}
  ];
  const rows=buildSessionTree(s,"win32");
  assert.deepEqual(rows.map(row=>row.session.id),["parent","child"]);
  assert.equal(rows[1]!.depth,1);
  assert.equal(isActiveSession(s[1]!,"c:\\work\\PARENT.JSONL",undefined,"win32"),true);
  assert.equal(isActiveSession(s[0]!,undefined,"child","win32"),true);
});
test("search is flat while default rows are tree-cached",()=>{
  const cache=new SessionSearchCache();
  const sessions=[
    {id:"child",path:"/work/child.jsonl",title:"Find me",cwd:"/work",modifiedMs:2,size:1,parentSession:"/work/parent.jsonl"},
    {id:"parent",path:"/work/parent.jsonl",title:"Parent",cwd:"/work",modifiedMs:1,size:1}
  ];
  cache.setSessions(sessions);
  const tree=cache.rows("");
  assert.deepEqual(tree.map(row=>row.session.id),["parent","child"]);
  assert.strictEqual(cache.rows(""),tree);
  const filtered=cache.rows("find");
  assert.deepEqual(filtered.map(row=>row.session.id),["child"]);
  assert.equal(filtered[0]?.depth,0);
});
test("scanner extracts parentSession from JSONL header",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pi-resume-lineage-"));
  try{
    const file=join(dir,"child.jsonl"),parent=join(dir,"main.jsonl");
    await writeFile(file,[
      JSON.stringify({type:"session",id:"child",cwd:dir,parentSession:parent}),
      JSON.stringify({type:"message",message:{role:"user",content:"Hello"}})
    ].join("\n")+"\n");
    const st=await stat(file);
    assert.equal((await readPreview(file,st.mtimeMs,st.size))?.parentSession,parent);
  }finally{await rm(dir,{recursive:true,force:true});}
});


test("archive: persists path-only metadata without touching transcript",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pi-resume-archive-"));
  try{
    const session=join(root,"project","one.jsonl");
    await mkdir(join(root,"project"));
    await writeFile(session,fixture("one",root,"unchanged"));
    const fs=await import("node:fs/promises");
    const before=await fs.readFile(session);
    const index=join(root,"agent","pi-resume","archive.json");
    const store=new ArchiveStore(index);
    await store.load();
    assert.equal(store.isArchived(session),false);
    await store.setArchived(session,true);
    assert.equal(store.isArchived(session),true);
    const reopened=new ArchiveStore(index);
    await reopened.load();
    assert.equal(reopened.isArchived(session),true);
    assert.deepEqual(await fs.readFile(session),before);
    await reopened.setArchived(session,false);
    await store.load();
    assert.equal(store.isArchived(session),false);
    assert.deepEqual(await fs.readFile(session),before);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("archive: preserves prior sequential updates from other instances",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pi-resume-archive-"));
  try{
    const path=join(root,"archive.json");
    const a=new ArchiveStore(path),b=new ArchiveStore(path);
    await Promise.all([a.load(),b.load()]);
    await a.setArchived(join(root,"a.jsonl"),true);
    await b.setArchived(join(root,"b.jsonl"),true);
    const latest=new ArchiveStore(path);
    await latest.load();
    assert.equal(latest.isArchived(join(root,"a.jsonl")),true);
    assert.equal(latest.isArchived(join(root,"b.jsonl")),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("archive: damaged or unknown versions are never overwritten",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pi-resume-archive-"));
  try{
    const path=join(root,"archive.json");
    await writeFile(path,'{"version":2,"paths":["important"]}');
    const store=new ArchiveStore(path);
    await assert.rejects(store.load(),/Unsupported or damaged/);
    await assert.rejects(store.setArchived(join(root,"any.jsonl"),true),/Unsupported or damaged/);
    assert.equal(await (await import("node:fs/promises")).readFile(path,"utf8"),
      '{"version":2,"paths":["important"]}');
  }finally{await rm(root,{recursive:true,force:true});}
});

test("archive: list partition retains tree lineage and Windows case handling",()=>{
  const parent={path:"/work/parent.jsonl",id:"parent",title:"Parent",cwd:"/work",modifiedMs:1,size:1};
  const child={path:"/work/child.jsonl",id:"child",title:"Child",cwd:"/work",modifiedMs:2,size:1,parentSession:parent.path};
  const other={path:"/work/other.jsonl",id:"other",title:"Other",cwd:"/work",modifiedMs:3,size:1};
  const archived=new Set([archivePathKey(other.path)]);
  const check=(path:string)=>archived.has(archivePathKey(path));
  const active=filterArchiveSessions([child,parent,other],check,false);
  const stored=filterArchiveSessions([child,parent,other],check,true);
  assert.deepEqual(buildSessionTree(active,"linux").map(x=>x.session.id),["parent","child"]);
  assert.deepEqual(stored.map(x=>x.id),["other"]);
  assert.equal(archivePathKey("C:\\Work\\A.jsonl","win32"),
    archivePathKey("c:\\work\\a.JSONL","win32"));
});


test("trash: moves only the selected session; siblings and children stay intact",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pi-resume-trash-"));
  try{
    const dir=join(root,"sessions"),bin=join(root,"bin");
    await mkdir(dir);await mkdir(bin);
    const parent=join(dir,"parent.jsonl");
    const child=join(dir,"child.jsonl");
    const other=join(dir,"other.jsonl");
    await writeFile(parent,fixture("parent",dir,"parent"));
    await writeFile(child,fixture("child",dir,"child"));
    await writeFile(other,fixture("other",dir,"other"));
    const st=await stat(parent);
    const destination=join(bin,"parent.jsonl");
    const fs=await import("node:fs/promises");
    await moveSessionToTrash({path:parent,size:st.size,modifiedMs:st.mtimeMs},
      async(path)=>{assert.equal(path,parent);await fs.rename(path,destination);});
    await assert.rejects(fs.lstat(parent),{code:"ENOENT"});
    assert.equal((await stat(child)).isFile(),true);
    assert.equal((await stat(other)).isFile(),true);
    assert.equal((await stat(destination)).isFile(),true);
    await fs.rename(destination,parent); // Restore demonstration.
    assert.equal((await stat(parent)).isFile(),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("trash: modified or replaced sessions are never sent to trash",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pi-resume-trash-"));
  try{
    const path=join(root,"one.jsonl");
    await writeFile(path,fixture("one",root,"hi"));
    const st=await stat(path);
    await appendFile(path,"\nupdated\n");
    let called=0;
    await assert.rejects(moveSessionToTrash({path,size:st.size,modifiedMs:st.mtimeMs},
      async()=>{called++;}),/Session changed/);
    assert.equal(called,0);
    assert.equal((await stat(path)).isFile(),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("trash: missing files and no-op provider never count as successful deletion",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pi-resume-trash-"));
  try{
    const path=join(root,"one.jsonl");
    await writeFile(path,fixture("one",root,"hi"));
    const st=await stat(path);
    let called=0;
    await assert.rejects(moveSessionToTrash({path,size:st.size,modifiedMs:st.mtimeMs},
      async()=>{called++;}),/still present/);
    assert.equal(called,1);
    await rm(path);
    await assert.rejects(moveSessionToTrash({path,size:st.size,modifiedMs:st.mtimeMs},
      async()=>{called++;}),{code:"ENOENT"});
    assert.equal(called,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("trash: non-session extensions cannot be targeted",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pi-resume-trash-"));
  try{
    const path=join(root,"notes.txt");
    await writeFile(path,"untouched");
    const st=await stat(path);
    await assert.rejects(moveSessionToTrash({path,size:st.size,modifiedMs:st.mtimeMs},
      async()=>{throw new Error("should not call trash");}),/non-session/);
    assert.equal((await import("node:fs/promises")).readFile(path,"utf8") instanceof Promise,true);
  }finally{await rm(root,{recursive:true,force:true});}
});
