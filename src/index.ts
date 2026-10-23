import {join} from "node:path";
import {getAgentDir,type ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {getWarmSnapshot,scanSessions} from "./core/scanner.ts";
import {ResumePicker,type Scope} from "./ui/picker.ts";

export default function(pi:ExtensionAPI){
  pi.registerCommand("presume",{
    description:"Fast read-only session picker (leaves /resume unchanged)",
    handler:async(args,ctx)=>{
      if(ctx.mode!=="tui"){
        if(ctx.hasUI)ctx.ui.notify("/presume requires Pi terminal UI","warning");
        return;
      }
      const abort=new AbortController();
      const currentDir=ctx.sessionManager.getSessionDir();
      const root=join(getAgentDir(),"sessions");
      const manager=ctx.sessionManager as typeof ctx.sessionManager&{usesDefaultSessionDir?:()=>boolean};
      const isCustomDir=manager.usesDefaultSessionDir?.()===false;
      const currentSession=ctx.sessionManager.getSessionFile()??undefined;
      let picker:ResumePicker|undefined;
      let selected:string|undefined;
      const started=new Set<Scope>();
      const runScope=(scope:Scope)=>{
        if(started.has(scope)||abort.signal.aborted||!currentDir)return;
        started.add(scope);
        const options={root,currentDir,scope,cwd:ctx.cwd,customDir:isCustomDir,filterCurrentByCwd:isCustomDir};
        picker?.seed(scope,getWarmSnapshot(options));
        void scanSessions({...options,signal:abort.signal,
          onBatch:(batch,progress)=>picker?.update(scope,batch,progress)
        }).catch(err=>picker?.fail(`Scan failed: ${err instanceof Error?err.message:String(err)}`));
      };
      try{
        selected=await ctx.ui.custom<string|undefined>((tui,theme,_kb,done)=>{
          picker=new ResumePicker(theme,{
            currentSession,initialQuery:args?.trim()||undefined,
            requestRender:()=>tui.requestRender(),onScope:runScope,done
          });
          setImmediate(()=>runScope("current"));
          return picker;
        });
      }finally{
        abort.abort();
        picker?.close();
      }
      if(selected){
        try{
          const result=await ctx.switchSession(selected);
          if(result.cancelled)ctx.ui.notify("Session switch cancelled","info");
        }catch(err){
          ctx.ui.notify(`Unable to resume: ${err instanceof Error?err.message:String(err)}`,"error");
        }
      }
    }
  });
}
