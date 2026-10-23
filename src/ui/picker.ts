import type {Theme} from "@earendil-works/pi-coding-agent";
import {getKeybindings,Input,truncateToWidth,visibleWidth,type Component} from "@earendil-works/pi-tui";
import {sameProjectPath,type SessionPreview,type ScanProgress} from "../core/scanner.ts";
import {SessionSearchCache} from "../core/search.ts";

export type Scope="current"|"all";
export interface PickerOptions {
  currentSession?:string; initialQuery?:string; requestRender():void;
  onScope(scope:Scope):void; done(sessionPath?:string):void;
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
  private selected=0;
  private selectedPath:string|undefined;
  private closed=false;
  private error:string|undefined;
  private _focused=false;
  constructor(private readonly theme:Theme,private readonly options:PickerOptions){
    if(options.initialQuery)this.input.setValue(options.initialQuery);
  }
  get focused(){return this._focused;}
  set focused(v:boolean){this._focused=v;this.input.focused=v;}
  close(){this.closed=true;}
  /** Immediately show the prior completed in-process snapshot, then revalidate in background. */
  seed(scope:Scope,rows:SessionPreview[]):void{
    if(this.closed||!rows.length||this.data[scope].length)return;
    this.data[scope]=rows.slice();
    this.positions[scope]=new Map(rows.map((s,i)=>[s.path,i]));
    this.search[scope].setSessions(this.data[scope]);
    if(this.scope===scope)this.reconcile();
    this.options.requestRender();
  }
  update(scope:Scope,batch:SessionPreview[],progress:ScanProgress):void{
    if(this.closed)return;
    let changed=false;
    const rows=this.data[scope],positions=this.positions[scope],observed=this.observed[scope];
    for(const row of batch){
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
      const valid=rows.filter(s=>observed.has(s.path));
      if(valid.length!==rows.length){
        this.data[scope]=valid;
        this.positions[scope]=new Map(valid.map((s,i)=>[s.path,i]));
        changed=true;
      }
    }
    this.progress[scope]=progress;
    if(changed){
      this.search[scope].setSessions(this.data[scope]);
      if(this.scope===scope)this.reconcile();
    }
    this.options.requestRender();
  }
  fail(message:string):void{if(!this.closed){this.error=message;this.options.requestRender();}}
  private results():SessionPreview[]{return this.search[this.scope].search(this.input.getValue());}
  private reconcile():void{
    const results=this.results();
    if(this.selectedPath){
      const index=results.findIndex(s=>s.path===this.selectedPath);
      if(index>=0){this.selected=index;return;}
    }
    this.selected=Math.max(0,Math.min(this.selected,results.length-1));
    this.selectedPath=results[this.selected]?.path;
  }
  invalidate():void{this.input.invalidate();}
  render(width:number):string[]{
    const t=this.theme,w=Math.max(12,width);
    const sessions=this.results(),p=this.progress[this.scope];
    const lines:string[]=[
      truncateToWidth(t.bold("Pi Resume")+t.fg("muted",` [${this.scope==="current"?"Current":"All"}]`),w),
      ...this.input.render(w),""
    ];
    if(!sessions.length)lines.push(t.fg("muted",p.complete?"  No matching sessions":"  Scanning sessions..."));
    else{
      const first=Math.min(Math.max(0,this.selected-Math.floor(PAGE/2)),Math.max(0,sessions.length-PAGE));
      for(let i=first;i<Math.min(first+PAGE,sessions.length);i++){
        const s=sessions[i]!;
        const mark=i===this.selected?"› ":"  ";
        const isCurrent=this.options.currentSession&&sameProjectPath(s.path,this.options.currentSession);
        const right=`${isCurrent?"• ":""}${age(s.modifiedMs)}`;
        const title=truncateToWidth(s.title,Math.max(4,w-visibleWidth(mark)-visibleWidth(right)-2),"…");
        const left=mark+title;
        const padding=" ".repeat(Math.max(1,w-visibleWidth(left)-visibleWidth(right)));
        const line=truncateToWidth(left+padding+right,w);
        lines.push(i===this.selected?t.bg("selectedBg",t.fg("accent",line)):t.fg("muted",line));
      }
      lines.push(t.fg("muted",`  ${this.selected+1}/${sessions.length} results`));
    }
    lines.push("");
    const status=p.complete?`Ready · ${p.loaded} files`:`Scanning ${p.loaded}/${p.total}${p.discovering?"+":""}`;
    lines.push(t.fg(this.error?"error":"muted",truncateToWidth(this.error||`${status}${p.failed?` · ${p.failed} skipped`:""}`,w)));
    lines.push(t.fg("muted",truncateToWidth("↑↓ select · Enter resume · Tab scope · Esc close · type to search",w)));
    return lines;
  }
  handleInput(data:string):void{
    const k=getKeybindings();
    if(k.matches(data,"tui.select.cancel")){this.close();this.options.done();return;}
    if(k.matches(data,"tui.input.tab")){
      this.scope=this.scope==="current"?"all":"current";
      this.selected=0;this.selectedPath=undefined;this.reconcile();
      this.options.onScope(this.scope);this.options.requestRender();return;
    }
    const list=this.results();
    if(k.matches(data,"tui.select.up"))this.selected=Math.max(0,this.selected-1);
    else if(k.matches(data,"tui.select.down"))this.selected=Math.max(0,Math.min(list.length-1,this.selected+1));
    else if(k.matches(data,"tui.select.pageUp"))this.selected=Math.max(0,this.selected-PAGE);
    else if(k.matches(data,"tui.select.pageDown"))this.selected=Math.max(0,Math.min(list.length-1,this.selected+PAGE));
    else if(k.matches(data,"tui.select.confirm")){
      const chosen=list[this.selected];
      if(chosen){this.close();this.options.done(chosen.path);}
      return;
    }else{
      this.input.handleInput(data);
      this.selected=0;this.selectedPath=undefined;
    }
    this.selectedPath=this.results()[this.selected]?.path;
    this.options.requestRender();
  }
}
