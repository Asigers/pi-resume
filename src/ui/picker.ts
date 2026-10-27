import type {Theme} from "@earendil-works/pi-coding-agent";
import {getKeybindings,Input,truncateToWidth,visibleWidth,type Component} from "@earendil-works/pi-tui";
import type {SessionPreview,ScanProgress} from "../core/scanner.ts";
import {archivePathKey,filterArchiveSessions} from "../core/archive.ts";
import {SessionSearchCache} from "../core/search.ts";
import {isActiveSession,treePrefix,type SessionRow} from "../core/tree.ts";

export type Scope="current"|"all";
export interface PickerOptions {
  currentSession?:string; currentSessionId?:string; initialQuery?:string; requestRender():void;
  onScope(scope:Scope):void; done(sessionPath?:string):void;
  isArchived(path:string):boolean; onArchive(path:string,archived:boolean):Promise<void>;
  onDelete(session:SessionPreview):Promise<{warning?:string}>;
}
const PAGE=12;
function age(time:number):string{
  const mins=Math.max(0,Math.floor((Date.now()-time)/60000));
  if(mins<1)return "now";
  if(mins<60)return `${mins}m`;
  if(mins<1440)return `${Math.floor(mins/60)}h`;
  return `${Math.floor(mins/1440)}d`;
}
export class ResumePicker implements Component {
  private input=new Input();
  private data:Record<Scope,SessionPreview[]>={current:[],all:[]};
  private positions:Record<Scope,Map<string,number>>={current:new Map(),all:new Map()};
  private observed:Record<Scope,Set<string>>={current:new Set(),all:new Set()};
  private search:Record<Scope,SessionSearchCache>={current:new SessionSearchCache(),all:new SessionSearchCache()};
  private progress:Record<Scope,ScanProgress>={
    current:{loaded:0,total:0,failed:0,complete:false,discovering:true},
    all:{loaded:0,total:0,failed:0,complete:false,discovering:true}
  };
  private scope:Scope="current";
  private archived=false;
  private busy=false;
  private confirmingDelete:SessionPreview|undefined;
  private deletedPaths=new Set<string>();
  private notice:string|undefined;
  private selected=0;
  private selectedPath:string|undefined;
  private active:Record<Scope,SessionPreview|undefined>={current:undefined,all:undefined};
  private selectionTouched=false;
  private closed=false;
  private error:string|undefined;
  private _focused=false;
  constructor(private readonly theme:Theme,private readonly options:PickerOptions){
    if(options.initialQuery)this.input.setValue(options.initialQuery);
  }
  get focused(){return this._focused;}
  set focused(v:boolean){this._focused=v;this.input.focused=v;}
  close(){this.closed=true;}
  private removeDeletedSession(path:string):void{
    const key=archivePathKey(path);
    this.deletedPaths.add(key);
    this.confirmingDelete=undefined;
    for(const scope of ["current","all"] as const){
      const rows=this.data[scope].filter(s=>archivePathKey(s.path)!==key);
      this.data[scope]=rows;
      this.positions[scope]=new Map(rows.map((s,i)=>[s.path,i]));
      this.observed[scope].delete(path);
      this.active[scope]=rows.find(r=>isActiveSession(
        r,this.options.currentSession,this.options.currentSessionId
      ));
      this.refreshVisible(scope);
    }
    this.selectedPath=undefined;
    this.selectionTouched=true;
    this.reconcile();
  }
  private async trashSession(session:SessionPreview):Promise<void>{
    if(this.busy||this.closed)return;
    this.busy=true;this.error=undefined;this.notice=undefined;
    this.options.requestRender();
    try{
      const result=await this.options.onDelete(session);
      if(this.closed)return;
      this.removeDeletedSession(session.path);
      this.notice=result.warning||"Moved session to system Trash. Other sessions were kept.";
    }catch(err){
      if(!this.closed)this.error="Could not move to Trash: "+
        (err instanceof Error?err.message:String(err));
    }finally{
      this.busy=false;
      if(!this.closed)this.options.requestRender();
    }
  }
  private refreshVisible(scope:Scope):void{
    this.search[scope].setSessions(filterArchiveSessions(
      this.data[scope],this.options.isArchived,this.archived
    ));
  }
  private async changeArchive(path:string,archived:boolean):Promise<void>{
    if(this.busy||this.closed)return;
    this.busy=true;
    this.error=undefined;
    this.options.requestRender();
    try{
      await this.options.onArchive(path,archived);
      if(this.closed)return;
      this.refreshVisible("current");
      this.refreshVisible("all");
      this.selected=0;
      this.selectedPath=undefined;
      this.selectionTouched=true;
      this.reconcile();
    }catch(err){
      if(!this.closed)this.error="Archive update failed: "+(err instanceof Error?err.message:String(err));
    }finally{
      this.busy=false;
      if(!this.closed)this.options.requestRender();
    }
  }
  /** Immediately show the prior completed in-process snapshot, then revalidate in background. */
  seed(scope:Scope,rows:SessionPreview[]):void{
    if(this.closed||!rows.length||this.data[scope].length)return;
    this.data[scope]=rows.filter(s=>!this.deletedPaths.has(archivePathKey(s.path)));
    this.positions[scope]=new Map(this.data[scope].map((s,i)=>[s.path,i]));
    this.refreshVisible(scope);
    this.active[scope]=rows.find(r=>isActiveSession(r,this.options.currentSession,this.options.currentSessionId));
    if(this.scope===scope)this.reconcile();
    this.options.requestRender();
  }
  update(scope:Scope,batch:SessionPreview[],progress:ScanProgress):void{
    if(this.closed)return;
    let changed=false;
    const rows=this.data[scope],positions=this.positions[scope],observed=this.observed[scope];
    for(const row of batch){
      if(this.deletedPaths.has(archivePathKey(row.path)))continue;
      if(isActiveSession(row,this.options.currentSession,this.options.currentSessionId))this.active[scope]=row;
      observed.add(row.path);
      const index=positions.get(row.path);
      if(index===undefined){
        positions.set(row.path,rows.length);rows.push(row);changed=true;
      }else if(rows[index]!==row){
        rows[index]=row;changed=true;
      }
    }
    if(progress.complete){
      // Remove stale snapshot rows that disappeared on disk during revalidation.
      const valid=rows.filter(s=>observed.has(s.path)&&!this.deletedPaths.has(archivePathKey(s.path)));
      if(valid.length!==rows.length){
        this.data[scope]=valid;
        this.positions[scope]=new Map(valid.map((s,i)=>[s.path,i]));
        this.active[scope]=valid.find(r=>isActiveSession(r,this.options.currentSession,this.options.currentSessionId));
        changed=true;
      }
    }
    this.progress[scope]=progress;
    if(changed){
      this.refreshVisible(scope);
      if(this.scope===scope)this.reconcile();
    }
    this.options.requestRender();
  }
  fail(message:string):void{if(!this.closed){this.error=message;this.options.requestRender();}}
  private results():SessionRow[]{return this.search[this.scope].rows(this.input.getValue());}
  private reconcile():void{
    const results=this.results();
    if(!this.selectionTouched&&!this.input.getValue().trim()){
      const active=results.findIndex(r=>isActiveSession(r.session,this.options.currentSession,this.options.currentSessionId));
      if(active>=0){this.selected=active;this.selectedPath=results[active]!.session.path;return;}
    }
    if(this.selectedPath){
      const index=results.findIndex(r=>r.session.path===this.selectedPath);
      if(index>=0){this.selected=index;return;}
    }
    this.selected=Math.max(0,Math.min(this.selected,results.length-1));
    this.selectedPath=results[this.selected]?.session.path;
  }
  invalidate():void{this.input.invalidate();}
  render(width:number):string[]{
    const t=this.theme,w=Math.max(12,width);
    const sessions=this.results(),p=this.progress[this.scope];
    const active=this.active[this.scope];
    const activeLabel=active?active.title:
      this.options.currentSessionId?(p.complete?"not in this scope":"loading session…"):"unsaved";
    const lines:string[]=[
      truncateToWidth(t.bold("Pi Resume")+t.fg("muted",` [${this.scope==="current"?"Current":"All"} · ${this.archived?"Archived":"Active"}]`),w),
      t.fg("accent",truncateToWidth(`CURRENT: ${activeLabel}`,w,"…")),
      ...this.input.render(w),""
    ];
    if(!sessions.length)lines.push(t.fg("muted",p.complete?(this.archived?"  No matching archived sessions":"  No matching sessions"):"  Scanning sessions..."));
    else{
      const first=Math.min(Math.max(0,this.selected-Math.floor(PAGE/2)),Math.max(0,sessions.length-PAGE));
      for(let i=first;i<Math.min(first+PAGE,sessions.length);i++){
        const row=sessions[i]!;
        const s=row.session;
        const mark=i===this.selected?"› ":"  ";
        const isCurrent=isActiveSession(s,this.options.currentSession,this.options.currentSessionId);
        const right=`${isCurrent?"[CURRENT] ":""}${age(s.modifiedMs)}`;
        const prefix=treePrefix(row);
        const title=truncateToWidth(s.title,Math.max(1,w-visibleWidth(mark)-visibleWidth(prefix)-visibleWidth(right)-2),"…");
        const left=mark+prefix+title;
        const padding=" ".repeat(Math.max(1,w-visibleWidth(left)-visibleWidth(right)));
        const line=truncateToWidth(left+padding+right,w);
        lines.push(i===this.selected?t.bg("selectedBg",t.fg("accent",line)):isCurrent?t.fg("accent",line):t.fg("muted",line));
      }
      lines.push(t.fg("muted",`  ${this.selected+1}/${sessions.length} results`));
    }
    lines.push("");
    const status=p.complete?`Ready · ${p.loaded} files`:`Scanning ${p.loaded}/${p.total}${p.discovering?"+":""}`;
    lines.push(t.fg(this.error?"error":"muted",truncateToWidth(this.error||this.notice||`${this.busy?"Working…":status}${p.failed?` · ${p.failed} skipped`:""}`,w)));
    if(this.confirmingDelete){
      lines.push(t.fg("error",truncateToWidth("Move this session to system Trash?",w)));
      lines.push(t.fg("accent",truncateToWidth("  "+this.confirmingDelete.title,w,"…")));
      lines.push(t.fg("muted",truncateToWidth("  "+this.confirmingDelete.path,w,"…")));
      lines.push(t.fg("muted",truncateToWidth("Y confirm · N/Esc cancel · child sessions are preserved",w)));
    }else{
      lines.push(t.fg("muted",truncateToWidth(this.archived?
        "↑↓ select · Enter/Ctrl+A restore · Ctrl+D trash · Ctrl+R active · Tab scope · Esc close":
        "↑↓ select · Enter resume · Ctrl+A archive · Ctrl+D trash · Ctrl+R archived · Tab scope · Esc close",w)));
    }
    return lines;
  }
  handleInput(data:string):void{
    const k=getKeybindings();
    if(this.busy)return;
    if(this.confirmingDelete){
      if(data==="y"||data==="Y"){
        const target=this.confirmingDelete;
        this.confirmingDelete=undefined;
        void this.trashSession(target);
      }else if(data==="n"||data==="N"||k.matches(data,"tui.select.cancel")){
        this.confirmingDelete=undefined;
        this.error=undefined;
        this.options.requestRender();
      }
      return;
    }
    if(k.matches(data,"tui.select.cancel")){this.close();this.options.done();return;}
    if(data==="\x04"){
      const row=this.results()[this.selected];
      if(!row)return;
      const s=row.session;
      this.notice=undefined;
      if(isActiveSession(s,this.options.currentSession,this.options.currentSessionId)){
        this.error="Cannot delete the current session. Switch to another session first.";
      }else{
        this.error=undefined;
        this.confirmingDelete=s;
      }
      this.options.requestRender();return;
    }
    // Ctrl+R changes the view; Ctrl+A archives/restores the highlighted session.
    if(data==="\x12"){
      if(this.busy)return;
      this.archived=!this.archived;
      this.refreshVisible("current");
      this.refreshVisible("all");
      this.selected=0;this.selectedPath=undefined;this.selectionTouched=false;this.reconcile();
      this.options.requestRender();return;
    }
    if(data==="\x01"){
      const chosen=this.results()[this.selected];
      if(chosen&&!this.busy)void this.changeArchive(chosen.session.path,!this.archived);
      return;
    }
    if(this.busy)return;
    if(k.matches(data,"tui.input.tab")){
      this.scope=this.scope==="current"?"all":"current";
      this.selected=0;this.selectedPath=undefined;this.selectionTouched=false;this.reconcile();
      this.options.onScope(this.scope);this.options.requestRender();return;
    }
    const list=this.results();
    if(k.matches(data,"tui.select.up"))this.selected=Math.max(0,this.selected-1);
    else if(k.matches(data,"tui.select.down"))this.selected=Math.max(0,Math.min(list.length-1,this.selected+1));
    else if(k.matches(data,"tui.select.pageUp"))this.selected=Math.max(0,this.selected-PAGE);
    else if(k.matches(data,"tui.select.pageDown"))this.selected=Math.max(0,Math.min(list.length-1,this.selected+PAGE));
    else if(k.matches(data,"tui.select.confirm")){
      const chosen=list[this.selected];
      if(chosen){
        if(this.archived)void this.changeArchive(chosen.session.path,false);
        else {this.close();this.options.done(chosen.session.path);}
      }
      return;
    }else{
      this.input.handleInput(data);
      this.selected=0;this.selectedPath=undefined;
    }
    this.selectionTouched=true;
    this.selectedPath=this.results()[this.selected]?.session.path;
    this.options.requestRender();
  }
}
