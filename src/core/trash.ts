import {lstat} from "node:fs/promises";
import {extname} from "node:path";
import trash from "trash";
import type {SessionPreview} from "./scanner.ts";

export type TrashFile=(path:string)=>Promise<void>;

/**
 * Move a single, unchanged session file into the operating system's Trash.
 * Never fall back to fs.unlink() or permanent deletion.
 */
export async function moveSessionToTrash(
  session:Pick<SessionPreview,"path"|"size"|"modifiedMs">,
  trashFile:TrashFile=(path)=>trash(path,{glob:false})
):Promise<void>{
  if(extname(session.path).toLowerCase()!==".jsonl"){
    throw new Error("Refusing to remove a non-session file");
  }
  // lstat rejects symlinks, directories, and stale selection after an edit/replacement.
  const before=await lstat(session.path);
  if(!before.isFile()||before.isSymbolicLink()){
    throw new Error("Selected session is no longer a regular file");
  }
  if(before.size!==session.size||before.mtimeMs!==session.modifiedMs){
    throw new Error("Session changed since scanning. Reopen /presume and try again");
  }
  await trashFile(session.path);
  // Some trash implementations succeed silently for unmatched files. Verify the source is gone.
  try{
    await lstat(session.path);
    throw new Error("File is still present; it was not moved to Trash");
  }catch(err){
    if((err as NodeJS.ErrnoException).code!=="ENOENT")throw err;
  }
}
