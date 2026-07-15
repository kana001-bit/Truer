import { resolve } from "node:path";

// True when two paths point at the SAME file. apply must never write over the source (in-place is
// forbidden, T1), and a plain string compare of resolved paths is not enough: on Windows the
// filesystem is case-insensitive, so `C:\Tmp\Foo.dxf` and `c:\tmp\foo.dxf` are the same file. A
// case-sensitive compare would treat them as different and let apply overwrite the source. Case-fold
// on win32; keep an exact compare elsewhere (POSIX filesystems are case-sensitive).
export function isSameFilePath(a: string, b: string): boolean {
  const resolvedA = resolve(a);
  const resolvedB = resolve(b);
  return process.platform === "win32"
    ? resolvedA.toLowerCase() === resolvedB.toLowerCase()
    : resolvedA === resolvedB;
}
