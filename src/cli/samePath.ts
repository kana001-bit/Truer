import { resolve } from "node:path";

// 2 つの path が同じ file を指すとき true。apply は source の上書きを決してしてはならず（in-place は
// 禁止、T1）、解決済み path の素の文字列比較では足りない: Windows の filesystem は case 非依存なので、
// `C:\Tmp\Foo.dxf` と `c:\tmp\foo.dxf` は同じ file。case 依存の比較はそれらを別物として扱い、apply に
// source を上書きさせてしまう。win32 では case-fold し、他では厳密比較を保つ（POSIX filesystem は
// case 依存）。
export function isSameFilePath(a: string, b: string): boolean {
  const resolvedA = resolve(a);
  const resolvedB = resolve(b);
  return process.platform === "win32"
    ? resolvedA.toLowerCase() === resolvedB.toLowerCase()
    : resolvedA === resolvedB;
}
