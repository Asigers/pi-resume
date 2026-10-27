import {join} from "node:path";
import {getAgentDir,type ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {clearScanCaches,getWarmSnapshot,scanSessions} from "./core/scanner.ts";
import {moveSessionToTrash} from "./core/trash.ts";
import type {SessionPreview} from "./core/scanner.ts";
import {ArchiveStore} from "./core/archive.ts";
import {ResumePicker,type Scope} from "./ui/picker.ts";

export default function(pi:ExtensionAPI){
  pi.registerCommand("presume",{
    description:"Fast session picker with archive and safe Trash deletion (leaves /resume unchanged)",
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
      const currentSessionId=ctx.sessionManager.getSessionId();
      const archive=new ArchiveStore(join(getAgentDir(),"pi-resume","archive.json"));
      try{await archive.load();}
      catch(err){
        ctx.ui.notify("Archive index unavailable: "+(err instanceof Error?err.message:String(err)),"error");
        return;
      }
      let picker:ResumePicker|undefined;
      let selected:string|undefined;
      const started=new Set<Scope>();
      const onDelete=async(session:SessionPreview):Promise<{warning?:string}>=>{
        // The selected path comes from the scanner; the trash routine revalidates it.
        await moveSessionToTrash(session);
        clearScanCaches();
        try{
          await archive.setArchived(session.path,false);
          return {};
        }catch(err){
          return {warning:"Moved to Trash, but could not clear archive metadata: "+
            (err instanceof Error?err.message:String(err))};
        }
      };
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
            currentSession,currentSessionId,initialQuery:args?.trim()||undefined,
            requestRender:()=>tui.requestRender(),onScope:runScope,
            isArchived:path=>archive.isArchived(path),
            onArchive:(path,archived)=>archive.setArchived(path,archived),
            onDelete,done
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
