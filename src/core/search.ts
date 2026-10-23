import type {SessionPreview} from "./scanner.ts";
export function findSessions(sessions:SessionPreview[],query:string):SessionPreview[]{
  const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return sessions.filter(s=>{
    if(!terms.length)return true;
    const text=`${s.title} ${s.cwd} ${s.id} ${s.path}`.toLocaleLowerCase();
    return terms.every(term=>text.includes(term));
  }).sort((a,b)=>b.modifiedMs-a.modifiedMs||a.path.localeCompare(b.path));
}
