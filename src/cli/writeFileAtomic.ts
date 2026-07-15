// Atomic file write for apply's `--out`: write a temp file in the SAME directory, then rename over
// the target. If apply crashes mid-write (error / disk full / Ctrl-C), the target is never left
// half-written — the reader always sees the old file or the complete new one
// (references/critical-invariants.md T1; mirrors Loomit's R1). The temp lives beside the target so
// the rename stays on one volume.

import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeFileAtomic(outPath: string, content: string): Promise<void> {
  const temp = join(dirname(outPath), `.tru-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temp, content, "utf8");
  await rename(temp, outPath);
}
