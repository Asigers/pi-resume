import {matchesKey} from "@earendil-works/pi-tui";

/** Match both legacy control bytes and CSI-u/Kitty extended keyboard input. */
export const isTrashShortcut=(input:string):boolean=>matchesKey(input,"ctrl+d");
export const isArchiveShortcut=(input:string):boolean=>matchesKey(input,"ctrl+a");
export const isArchiveViewShortcut=(input:string):boolean=>matchesKey(input,"ctrl+r");
