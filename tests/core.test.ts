import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm,stat} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {test} from "node:test";
import {acceptHeaderLine,previewTitle,tailName} from "../src/core/parse.ts";
import {listSessionPaths,readPreview,scanSessions} from "../src/core/scanner.ts";
import {findSessions} from "../src/core/search.ts";
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
