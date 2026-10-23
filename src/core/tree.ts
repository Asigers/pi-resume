import {posix,win32} from "node:path";
import type {SessionPreview} from "./scanner.ts";

/** Mirrors Pi's parentSession-based hierarchy. Not every subagent creates a linked session. */
export interface SessionRow {
  session:SessionPreview;
  depth:number;
  isLast:boolean;
  ancestorContinues:boolean[];
  orphan:boolean;
}
interface TreeNode {session:SessionPreview;children:TreeNode[];key:string;orphan:boolean}
function pathKey(path:string|undefined,platform:NodeJS.Platform):string|undefined{
  if(!path)return undefined;
  const lib=platform==="win32"?win32:posix;
  const value=lib.resolve(path);
  return platform==="win32"?value.toLowerCase():value;
}
const byRecency=(a:SessionPreview,b:SessionPreview)=>
  b.modifiedMs-a.modifiedMs||a.path.localeCompare(b.path);

/** The result is flat for keyboard navigation but retains tree branch metadata. */
export function buildSessionTree(sessions:SessionPreview[],platform:NodeJS.Platform=process.platform):SessionRow[]{
  const nodes=new Map<string,TreeNode>();
  for(const session of sessions){
    const key=pathKey(session.path,platform)!;
    nodes.set(key,{session,children:[],key,orphan:false});
  }
  const roots:TreeNode[]=[];
  for(const node of nodes.values()){
    const key=pathKey(node.session.parentSession,platform);
    const parent=key?nodes.get(key):undefined;
    if(parent&&parent!==node)parent.children.push(node);
    else {
      node.orphan=Boolean(key&&!parent);
      roots.push(node);
    }
  }
  const sort=(items:TreeNode[])=>items.sort((a,b)=>byRecency(a.session,b.session));
  sort(roots);
  for(const node of nodes.values())sort(node.children);

  const visited=new Set<string>(),rows:SessionRow[]=[];
  type Item={node:TreeNode;depth:number;isLast:boolean;continuation:boolean[]};
  const append=(start:TreeNode[]):void=>{
    const stack:Item[]=start.map((node,i)=>({
      node,depth:0,isLast:i===start.length-1,continuation:[]
    })).reverse();
    while(stack.length){
      const {node,depth,isLast,continuation}=stack.pop()!;
      if(visited.has(node.key))continue;
      visited.add(node.key);
      rows.push({session:node.session,depth,isLast,ancestorContinues:continuation,orphan:node.orphan});
      for(let i=node.children.length-1;i>=0;i--){
        stack.push({node:node.children[i]!,depth:depth+1,
          isLast:i===node.children.length-1,
          continuation:depth===0?[]:[...continuation,!isLast]});
      }
    }
  };
  append(roots);
  // A malformed parent cycle has no root: still show each session once.
  const missing=[...nodes.values()].filter(node=>!visited.has(node.key));
  sort(missing);
  append(missing);
  return rows;
}
export function treePrefix(row:SessionRow):string{
  if(row.depth===0)return row.orphan?"↳ ":"";
  return row.ancestorContinues.map(v=>v?"│  ":"   ").join("")+
    (row.isLast?"└─ ":"├─ ");
}
export function isActiveSession(
  session:SessionPreview,currentPath?:string,currentId?:string,
  platform:NodeJS.Platform=process.platform
):boolean{
  return Boolean(currentPath&&pathKey(session.path,platform)===pathKey(currentPath,platform))||
    Boolean(currentId&&session.id===currentId);
}
