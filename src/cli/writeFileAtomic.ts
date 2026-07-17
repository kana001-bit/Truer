// apply の `--out` 用の atomic file write: 同じディレクトリに temp file を書き、target の上に rename する。
// apply が書き込み途中で crash（error / disk full / Ctrl-C）しても、target が半分だけ書かれた状態に残る
// ことは決してない — 読み手は常に古い file か完全な新しい file のどちらかを見る
//（references/critical-invariants.md T1; Loomit の R1 に倣う）。temp は target の隣に置くので、rename は
// 1 つの volume に収まる。

import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeFileAtomic(outPath: string, content: string): Promise<void> {
  const temp = join(dirname(outPath), `.tru-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temp, content, "utf8");
  await rename(temp, outPath);
}
