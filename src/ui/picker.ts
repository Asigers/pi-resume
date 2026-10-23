import type {Theme} from "@earendil-works/pi-coding-agent";
import {getKeybindings,Input,truncateToWidth,visibleWidth,type Component} from "@earendil-works/pi-tui";
import type {SessionPreview,ScanProgress} from "../core/scanner.ts";
import {findSessions} from "../core/search.ts";

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
  private progress:Record<Scope,ScanProgress>={
    current:{loaded:0,total:0,failed:0,complete:false},
    all:{loaded:0,total:0,failed:0,complete:false}
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
  update(scope:Scope,batch:SessionPreview[],progress:ScanProgress):void{
    if(this.closed)return;
    const all=this.data[scope];
    const existing=new Set(all.map(s=>s.path));
    for(const s of batch)if(!existing.has(s.path)){all.push(s);existing.add(s.path);}
    this.progress[scope]=progress;
    this.reconcile();
    this.options.requestRender();
  }
  fail(message:string):void{if(!this.closed){this.error=message;this.options.requestRender();}}
  private results():SessionPreview[]{return findSessions(this.data[this.scope],this.input.getValue());}
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
        const right=`${s.path===this.options.currentSession?"• ":""}${age(s.modifiedMs)}`;
        const title=truncateToWidth(s.title,Math.max(4,w-visibleWidth(mark)-visibleWidth(right)-2),"…");
        const left=mark+title;
        const padding=" ".repeat(Math.max(1,w-visibleWidth(left)-visibleWidth(right)));
        const line=truncateToWidth(left+padding+right,w);
        lines.push(i===this.selected?t.bg("selectedBg",t.fg("accent",line)):t.fg("muted",line));
      }
      lines.push(t.fg("muted",`  ${this.selected+1}/${sessions.length} results`));
    }
    lines.push("");
    const status=p.complete?`Ready · ${p.loaded} files`:`Loading ${p.loaded}/${p.total||"?"}`;
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
    else if(k.matches(data,"tui.select.down"))this.selected=Math.min(list.length-1,this.selected+1);
    else if(k.matches(data,"tui.select.pageUp"))this.selected=Math.max(0,this.selected-PAGE);
    else if(k.matches(data,"tui.select.pageDown"))this.selected=Math.min(list.length-1,this.selected+PAGE);
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
