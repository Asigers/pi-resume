import type {SessionPreview} from "./scanner.ts";
import {buildSessionTree,type SessionRow} from "./tree.ts";
export function findSessions(sessions:SessionPreview[],query:string):SessionPreview[]{
  const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return sessions.filter(s=>{
    if(!terms.length)return true;
    const text=`${s.title} ${s.cwd} ${s.id} ${s.path}`.toLocaleLowerCase();
    return terms.every(term=>text.includes(term));
  }).sort((a,b)=>b.modifiedMs-a.modifiedMs||a.path.localeCompare(b.path));
}
/** Memoizes search + sort for the current data generation and query. */
export class SessionSearchCache {
  private sessions:SessionPreview[]=[];
  private lastQuery:string|undefined;
  private lastResults:SessionPreview[]|undefined;
  private rowQuery:string|undefined;
  private lastRows:SessionRow[]|undefined;
  setSessions(sessions:SessionPreview[]):void{
    this.sessions=sessions;
    this.lastQuery=undefined;
    this.lastResults=undefined;
    this.rowQuery=undefined;
    this.lastRows=undefined;
  }
  /** No query: native-style threaded tree. During search: native-style flat results. */
  rows(query:string):SessionRow[]{
    if(this.lastRows&&this.rowQuery===query)return this.lastRows;
    const matched=this.search(query);
    this.rowQuery=query;
    this.lastRows=query.trim()
      ?matched.map(session=>({session,depth:0,isLast:true,ancestorContinues:[],orphan:false}))
      :buildSessionTree(matched);
    return this.lastRows;
  }
  search(query:string):SessionPreview[]{
    if(this.lastResults&&this.lastQuery===query)return this.lastResults;
    this.lastQuery=query;
    this.lastResults=findSessions(this.sessions,query);
    return this.lastResults;
  }
}
