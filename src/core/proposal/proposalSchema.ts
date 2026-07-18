// Truer proposal file の contract（`truer.proposal.v0`）。
//
// このモジュールは、`tru propose` が書き `tru apply`（と将来の Loomit Studio）が読む
// proposal file の *shape* を所有する。ここは compatibility surface: required field は
// 明示的な schema break なしに rename・削除しない
//（references/critical-invariants.md T9、references/testing-proposals.md を参照）。
//
// Geometry source は 2026-07-11 pivot 以降 DXF (ASTM)。直す edge は SVG path id ではなく、
// Seamlint `structuralEdges` primitive 上の BLOCK 名 + `edgeId`/`arcRange` で addressing する
//（docs/truer-mvp-spec.md）。この `target` 再設計は明示的で文書化された v0 schema break:
// まだ contract を消費するものが無い（apply/preview/Studio は未実装）ので、v1 に上げず
// v0 をその場で作り直している。
//
// pure で IO を持たない。Digest は ./proposalDigest.ts から、組み立ては
// ./createProposalFile.ts から来る。

export const PROPOSAL_SCHEMA_V0 = "truer.proposal.v0";
export type ProposalSchema = typeof PROPOSAL_SCHEMA_V0;

export type ProposalStatus = "proposed" | "accepted" | "rejected" | "applied";
export type ProposalMode = "preview-only" | "local-adjustment";
export type IntentConfidence = "low" | "medium" | "high";

// Change kind。`apply` は `kind` で dispatch する; 未知の kind は明示的な error にし、
// silent skip はしない（T9）。新しい kind は references/extensibility.md で足す。
//
// `move-vertex` は DXF net-line 用の kind: addressing した edge の flattened polyline の
// 内部 vertex を 1 つ新しい点へ動かす（curve_kink smoothing）。最小・局所 — vertex 1 つ
//（T6）— で、apply が再計算しないよう self-contained に記録する（T4）。propose/preview/apply の
// 三点で同期させて追加した（references/extensibility.md E2）: fix が計算し（src/core/fixes/）、
// applyChanges が dispatch し（src/core/apply/）、overlay は applyChanges の出力を描くので
// preview は自動で追従する（T2）。apply の書き先は Truer 所有の補正済み DXF（`--out`）で、
// `.val`/Loomit master ではない（M3、2026-07-16）。
//
// `replace-path-data` は *legacy SVG* 用の kind（path の `d` 文字列を操作する）で、pivot 前の
// svg adapter 経路のために残している。net-line point 操作ではないので、applyChanges
//（DXF net-line point を扱う）はこれを処理しない。
export type ChangeKind = "replace-path-data" | "move-vertex";

// Truer が現在 correction proposal を作る Seamlint diagnostic code。
// それ以外は diagnostic を捨てず `skipped` entry にする（T8）。
//
//   - geometry.curve_kink: 単一 edge + `actual.point`。first slice は preview-only。
//   - geometry.seam_length_mismatch: *ペア* の diagnostic（`target` は "a/b"、`actual.point`
//     は無い; fromLengthMm/toLengthMm/lengthDiffMm を持つ）。ペアの "from" edge を anchor に
//     して addressing する — これは表示用の addressing anchor であって、どちらの edge を
//     変えるかの主張ではない（T6）。どちらが Δ を吸収するか、そして apply の書き先は未決なので、
//     これも preview-only（`changes: []`）のまま。
export const SUPPORTED_DIAGNOSTIC_CODES = [
  "geometry.curve_kink",
  "geometry.seam_length_mismatch"
] as const;

// Truer の skip-reason code（安定・英語; 文面は `message` に置く）。
// references/testing-proposals.md の "Codes" を参照。
export const SKIP_UNSUPPORTED_DIAGNOSTIC_CODE = "proposal.unsupported_diagnostic_code";
// curve_kink に有効な `actual.point` が無い。
export const SKIP_MISSING_DIAGNOSTIC_POINT = "proposal.missing_diagnostic_point";
// seam_length_mismatch に必要な有限の length field（from/to/diff mm）が欠けている。
export const SKIP_MISSING_LENGTH_FIELDS = "proposal.missing_length_fields";
// DXF addressing: target の BLOCK/edge が source に無い、または一意でない。
export const SKIP_TARGET_NOT_FOUND = "proposal.target_not_found";
export const SKIP_AMBIGUOUS_TARGET = "proposal.ambiguous_target";
// Legacy SVG path: pivot 前の svg adapter 経路のために残す。DXF addressing では使わない。
export const SKIP_PATH_NOT_FOUND = "proposal.path_not_found";

export interface Point {
  x: number;
  y: number;
}

export interface ReplacePathDataChange {
  kind: "replace-path-data";
  from: string;
  to: string;
}

// addressing した edge の net-line polyline の vertex を 1 つ `to` へ動かす。`vertexIndex` は
// edge の `points`（targetDigest に digest したのと同じ canonical な net-line points）への
// 0 始まり index。だから apply/preview はどちらも applyChanges という単一関数で補正後 edge を
// 再構成し、preview は apply と決してずれない（T2）。内部 vertex のみ: fix は endpoint を
// 触らず（T7）、endpoint に触れる move を絶対に emit しない。
export interface MoveVertexChange {
  kind: "move-vertex";
  vertexIndex: number;
  to: Point;
}

export type Change = ReplacePathDataChange | MoveVertexChange;

export interface SourceDiagnostic {
  code: string;
  severity?: string;
  target?: string;
  expected?: unknown;
  actual?: {
    point?: Point;
    angleDeg?: number;
    [key: string]: unknown;
  };
  suggestion?: string[];
  message?: string;
}

export interface Intent {
  kind: string;
  confidence: IntentConfidence;
  // MVP: 常に true。Seamlint severity を apply 許可として扱うことは無い（T3）。
  reviewRequired: boolean;
}

export interface MovedPoint {
  from: Point;
  to: Point;
}

// preview overlay に描く seam ペアの片方の edge。seam_length_mismatch proposal に付く
//（seamReconciliation と対になる）。`points` は Seamlint `structuralEdges` から来る edge の
// net-line polyline で、overlay はこれを直接描く。proposal は self-contained:
// `digestEdgePoints(points)` は対応する seamReconciliation edge の `edgeDigest` と一致するので、
// overlay は proposal だけから再現できる（preview 時に DXF / Seamlint を呼び直さない）。
// Render geometry はここに、addressing/identity は seamReconciliation に置く — 両者は
// 意図的に分けている。
export interface PreviewEdge {
  role: "from" | "to";
  points: Point[];
}

export interface ProposalPreview {
  diagnosticPoint?: Point;
  movedPoints?: MovedPoint[];
  // seam overlay 用の render geometry（不一致な 2 edge）。任意・追加的。
  edges?: PreviewEdge[];
  // addressing した単一 edge（curve_kink）用の render geometry: その edge の net-line points。
  // overlay はこれを original line として描き、補正後の line は applyChanges で導く（だから
  // preview == apply、T2）。self-contained: digestEdgePoints(edge.points) === target.targetDigest、
  // test で固定。任意・追加的。
  edge?: { points: Point[] };
}

export interface ProposalTarget {
  // DXF addressing: BLOCK 名 + Seamlint `structuralEdges` primitive 上の edge。
  // edge は `edgeId`、`arcRange`、またはその両方で addressing する — 少なくとも一方が
  // 必要（docs/truer-mvp-spec.md:「BLOCK name + edgeId/arcRange」）。arcRange でしか安定して
  // 識別できない edge もあるので、edgeId は必須ではない。
  blockName: string;
  edgeId?: string;
  // piece loop の正規化された [start, end] slice（Seamlint arcRange）: 原点は最初の corner、
  // 値は 0..1、start < end（edge は corner 境界で、原点をまたがない）。安定した edgeId が
  // 無いとき、これ単体で edge を addressing できる。
  arcRange?: [number, number];
  // addressing した edge の net-line geometry の digest。apply が書く前に照合する（T3）。
  targetDigest: string;
}

// 不一致な seam ペアの片方の edge。ProposalTarget と同じ DXF addressing に加え、この edge 自身の
// geometry digest と実測長を持つ。seam_length_mismatch proposal は（anchor だけでなく）両方の
// edge を記録するので、将来の apply がペア全体で gate できる
//（references/critical-invariants.md T3; anchor だけ digest していた穴を塞ぐ）。
export interface SeamEdge {
  blockName: string;
  edgeId?: string;
  arcRange?: [number, number];
  // この edge の net-line geometry の digest（digestPathData 経由）。
  edgeDigest: string;
  // この edge の実測長 mm（diagnostic から）。
  lengthMm: number;
}

// seam_length_mismatch で Truer が推す修正の「種類」（advisory）。Truer は種類と目標を推すが、val の
// 案文は書かない（詳細は docs/design-history.md の 2026-07-18 章 /
// docs/branch/feature/seam-length-adjustment.md）。
//   - "structural-link": Valentina の構築で 2 辺の長さを共有(リンク)する。恒久・再発なし・mid-process の
//     本命で既定に推す。案文（VLineLength/VIncrement の配線）は人が Valentina 側で当てる。
//   - "corner-slide": 共有コーナーを隣辺に沿って滑らせる幾何パッチ。その場限りの fallback・pre-cut
//     （val が未リンクのままなら再生成で再発する band-aid）。
export type FixKind = "structural-link" | "corner-slide";

// fixKind === "structural-link" のときの推奨内容（linkTarget があれば fixKind は structural-link）。
// Valentina の角は導出点のことがあり座標では直接動かせないので、案文（xy）ではなく **目標長** で人へ
// 渡す:「conform 側の辺の finished 長を targetFinishedMm にせよ」。住所は seamReconciliation の
// fromEdge/toEdge にあるので、ここは動かす側と目標長だけを持つ。
export interface LinkTarget {
  // 合わせる側（= reference の反対辺 = 動かす辺）。この辺を targetFinishedMm に合わせる。
  conform: "from" | "to";
  // conform 辺が到達すべき finished 長 mm（有限・非負）。ease=0 なら reference 辺の長さと一致し、宣言
  // ease があるとそのぶんずれる。実際の数値は builder が計算する責務（schema は shape と関係のみ検証）。
  targetFinishedMm: number;
}

// seam_length_mismatch の decision 2（reference に合わせる）を表す: 一方の edge を正とする
// `reference`（固定）にし、もう一方を ±Δ 調整して合わせる。reference が指定される
//（Loomit/人間の token）までは `reference` は undefined。undefined の間、proposal は両方向を
// 提示する preview-only のままで、どちらの edge を変えるか推測しない（T6）。
// seam_length_mismatch proposal にのみ付く。
export interface SeamReconciliation {
  fromEdge: SeamEdge;
  toEdge: SeamEdge;
  // 長さの差の絶対値 |fromLen - toLen| mm。向きは `reference` と 2 edge の長さから導ける。
  deltaMm: number;
  // どちらの edge が固定 reference か、undefined = 未決（両方向）。
  reference?: "from" | "to";
  // --- Slice 1（2026-07-18）追加。いずれも任意・追加的（additive, T9）。proposal は依然 preview-only ---
  // 宣言された ease（意図された長さ差 mm、既定 0 = 揃うべき）。measured の deltaMm と対で「いせ(意図)か
  // mistake か」を分ける。reconcile 目標は |fromLen - toLen| == easeMm（equal は easeMm=0 の特殊ケース）。
  easeMm?: number;
  // Truer が推す修正の種類（advisory）。①structural-link を既定に推し、②corner-slide は fallback。
  fixKind?: FixKind;
  // fixKind === "structural-link" のときの推奨内容（どの辺を、どの finished 長へリンクせよ）。
  linkTarget?: LinkTarget;
}

export interface Proposal {
  id: string;
  status: ProposalStatus;
  mode: ProposalMode;
  target: ProposalTarget;
  sourceDiagnostic: SourceDiagnostic;
  intent: Intent;
  // apply が実行する最小の操作リスト。`preview-only` proposal は `[]`（T2）。
  changes: Change[];
  preview: ProposalPreview;
  notes: string[];
  // seam_length_mismatch proposal にのみ付く: 不一致ペア、両 edge の digest、差、そして
  //（もしあれば）どちらが reference か。任意・追加的。
  seamReconciliation?: SeamReconciliation;
}

export interface ProposalSource {
  file: string;
  sourceDigest: string;
  createdBy: string;
}

// proposal になれなかった diagnostic。何も silent に捨てないよう理由とともに残す（T8）。
// file への追加的なもので、proposal ではない。
export interface SkippedDiagnostic {
  // Truer の skip-reason code（例: proposal.unsupported_diagnostic_code）。
  code: string;
  // 元の diagnostic 自身の code。report のために保持する。
  diagnosticCode: string;
  message: string;
  diagnostic: unknown;
}

export interface ProposalFile {
  schema: ProposalSchema;
  source: ProposalSource;
  proposals: Proposal[];
  skipped: SkippedDiagnostic[];
}

export function isSupportedDiagnosticCode(code: string): boolean {
  return (SUPPORTED_DIAGNOSTIC_CODES as readonly string[]).includes(code);
}

const STATUSES: readonly ProposalStatus[] = ["proposed", "accepted", "rejected", "applied"];
const MODES: readonly ProposalMode[] = ["preview-only", "local-adjustment"];
const FIX_KINDS: readonly FixKind[] = ["structural-link", "corner-slide"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Seamlint arcRange: piece loop の正規化された [start, end] slice、原点は最初の corner、
// 値は 0..1（Seamlint structuralEdges の規約）。edge は corner 境界で原点をまたがないので
// start < end。swap 済み / [0,1] 外の range はここで弾き、壊れた addressing（例: [0.9, 0.1] や
// [2, -1]）が保存された proposal に届いて後の edge resolution や digest 照合を壊さないようにする。
function isArcRange(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [start, end] = value as [unknown, unknown];
  return (
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end <= 1 &&
    start < end
  );
}

// SeamEdge には DXF addressing（blockName + edgeId または arcRange。ProposalTarget と同じ T6
// ルールを再利用）、空でない digest、有限の length が要る。
function isSeamEdge(value: unknown): value is SeamEdge {
  if (typeof value !== "object" || value === null) return false;
  const edge = value as Record<string, unknown>;
  if (!isNonEmptyString(edge.blockName)) return false;
  if (!isNonEmptyString(edge.edgeDigest)) return false;
  if (typeof edge.lengthMm !== "number" || !Number.isFinite(edge.lengthMm)) return false;
  if (edge.edgeId !== undefined && !isNonEmptyString(edge.edgeId)) return false;
  if (edge.arcRange !== undefined && !isArcRange(edge.arcRange)) return false;
  // addressing には edgeId / arcRange の少なくとも一方が要る（T6: edge を推測しない）。
  if (!isNonEmptyString(edge.edgeId) && !isArcRange(edge.arcRange)) return false;
  return true;
}

function isFinitePoint(value: unknown): value is Point {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.x === "number" &&
    Number.isFinite(point.x) &&
    typeof point.y === "number" &&
    Number.isFinite(point.y)
  );
}

// preview edge には from/to の role と、有限な net-line point が最低 2 つ要る（edge は polyline:
// 最低 2 corner）。digest==edgeDigest の invariant はここではなく test で固定するので、
// validation は digest module に依存しない。
function isPreviewEdge(value: unknown): value is PreviewEdge {
  if (typeof value !== "object" || value === null) return false;
  const edge = value as Record<string, unknown>;
  if (edge.role !== "from" && edge.role !== "to") return false;
  if (!Array.isArray(edge.points) || edge.points.length < 2) return false;
  return edge.points.every(isFinitePoint);
}

// 記録された 1 change の shape を検証する。壊れた change は apply にゴミを書かせるか crash させる
// ので、保存された proposal に絶対に届かせない。問題があれば文字列を、shape が正しければ undefined
// を返す。（実行時に apply がその kind を *サポート* するかは applyChanges の担当 — T9; ここでは
// この v0 model が emit しうる kind の shape を検査し、未知の kind を弾いて、壊れた file が contract
// guard を通らないようにする。）
function changeError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "must be an object";
  const change = value as Record<string, unknown>;
  if (change.kind === "move-vertex") {
    if (
      typeof change.vertexIndex !== "number" ||
      !Number.isInteger(change.vertexIndex) ||
      change.vertexIndex < 0
    ) {
      return "move-vertex vertexIndex must be a non-negative integer";
    }
    if (!isFinitePoint(change.to)) return "move-vertex to must be a finite point";
    return undefined;
  }
  if (change.kind === "replace-path-data") {
    if (!isNonEmptyString(change.from) || typeof change.to !== "string") {
      return "replace-path-data must carry a non-empty from and a string to";
    }
    return undefined;
  }
  return `has unknown kind ${JSON.stringify(change.kind)}`;
}

function validateProposal(candidate: unknown, index: number, errors: string[]): void {
  const at = `proposals[${index}]`;
  if (typeof candidate !== "object" || candidate === null) {
    errors.push(`${at} must be an object`);
    return;
  }
  const proposal = candidate as Record<string, unknown>;

  if (!isNonEmptyString(proposal.id)) errors.push(`${at}.id is required`);
  if (!(STATUSES as readonly string[]).includes(proposal.status as string)) {
    errors.push(`${at}.status must be one of ${STATUSES.join(" | ")}`);
  }
  if (!(MODES as readonly string[]).includes(proposal.mode as string)) {
    errors.push(`${at}.mode must be one of ${MODES.join(" | ")}`);
  }

  const target = proposal.target as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object") {
    errors.push(`${at}.target is required`);
  } else {
    if (!isNonEmptyString(target.blockName)) errors.push(`${at}.target.blockName is required`);
    if (!isNonEmptyString(target.targetDigest))
      errors.push(`${at}.target.targetDigest is required`);
    if (target.edgeId !== undefined && !isNonEmptyString(target.edgeId)) {
      errors.push(`${at}.target.edgeId must be a non-empty string when present`);
    }
    if (target.arcRange !== undefined && !isArcRange(target.arcRange)) {
      errors.push(
        `${at}.target.arcRange must be a normalized [start, end] with 0 <= start < end <= 1`
      );
    }
    // addressing には edgeId / arcRange の少なくとも一方が要る（T6: edge を推測しない）。
    if (!isNonEmptyString(target.edgeId) && !isArcRange(target.arcRange)) {
      errors.push(`${at}.target must address the edge by edgeId or arcRange`);
    }
  }

  const sourceDiagnostic = proposal.sourceDiagnostic as Record<string, unknown> | undefined;
  if (!sourceDiagnostic || !isNonEmptyString(sourceDiagnostic.code)) {
    errors.push(`${at}.sourceDiagnostic.code is required`);
  }

  const intent = proposal.intent as Record<string, unknown> | undefined;
  if (!intent || typeof intent.reviewRequired !== "boolean") {
    errors.push(`${at}.intent.reviewRequired must be a boolean`);
  }

  if (!Array.isArray(proposal.changes)) {
    errors.push(`${at}.changes must be an array`);
  } else if (proposal.mode === "preview-only" && proposal.changes.length !== 0) {
    // T2: preview-only proposal は apply するものを何も見せない。
    errors.push(`${at} is preview-only but carries changes`);
  } else {
    // local-adjustment は changes を持つ; 壊れた change が apply に届かないよう各 shape を
    // 検証する（T9）。preview-only は [] なのでこの loop は no-op。
    proposal.changes.forEach((change, changeIndex) => {
      const problem = changeError(change);
      if (problem !== undefined) errors.push(`${at}.changes[${changeIndex}] ${problem}`);
    });
  }

  // seamReconciliation は任意・追加的; 存在するときだけ検証する。
  if (proposal.seamReconciliation !== undefined) {
    const seam = proposal.seamReconciliation as Record<string, unknown>;
    if (typeof seam !== "object" || seam === null) {
      errors.push(`${at}.seamReconciliation must be an object when present`);
    } else {
      if (!isSeamEdge(seam.fromEdge)) {
        errors.push(`${at}.seamReconciliation.fromEdge is not a valid seam edge`);
      }
      if (!isSeamEdge(seam.toEdge)) {
        errors.push(`${at}.seamReconciliation.toEdge is not a valid seam edge`);
      }
      if (typeof seam.deltaMm !== "number" || !Number.isFinite(seam.deltaMm)) {
        errors.push(`${at}.seamReconciliation.deltaMm must be a finite number`);
      }
      if (seam.reference !== undefined && seam.reference !== "from" && seam.reference !== "to") {
        errors.push(`${at}.seamReconciliation.reference must be "from", "to", or omitted`);
      }
      // Slice 1 の advisory field（すべて任意・追加的）: 存在するときだけ shape を検証する。
      if (
        seam.easeMm !== undefined &&
        (typeof seam.easeMm !== "number" || !Number.isFinite(seam.easeMm) || seam.easeMm < 0)
      ) {
        errors.push(
          `${at}.seamReconciliation.easeMm must be a non-negative finite number when present`
        );
      }
      if (
        seam.fixKind !== undefined &&
        !(FIX_KINDS as readonly string[]).includes(seam.fixKind as string)
      ) {
        errors.push(`${at}.seamReconciliation.fixKind must be one of ${FIX_KINDS.join(" | ")}`);
      }
      if (seam.linkTarget !== undefined) {
        const link = seam.linkTarget as Record<string, unknown>;
        if (typeof link !== "object" || link === null) {
          errors.push(`${at}.seamReconciliation.linkTarget must be an object when present`);
        } else {
          if (link.conform !== "from" && link.conform !== "to") {
            errors.push(`${at}.seamReconciliation.linkTarget.conform must be "from" or "to"`);
          }
          if (
            typeof link.targetFinishedMm !== "number" ||
            !Number.isFinite(link.targetFinishedMm) ||
            link.targetFinishedMm < 0
          ) {
            errors.push(
              `${at}.seamReconciliation.linkTarget.targetFinishedMm must be a non-negative finite number`
            );
          }
          // relation（shape だけでなく整合も見る。move-vertex↔preview.edge と同じ方針）: linkTarget は
          // fixKind === "structural-link" の payload で、conform は reference の反対側（= 動かす辺）。
          // 矛盾した advisory record を下流へ渡さないため、種類・向きの整合も検証する。
          if (seam.fixKind !== "structural-link") {
            errors.push(
              `${at}.seamReconciliation.linkTarget is only valid when fixKind is "structural-link"`
            );
          }
          if (seam.reference !== "from" && seam.reference !== "to") {
            errors.push(
              `${at}.seamReconciliation.linkTarget requires reference to designate the fixed edge`
            );
          } else if (link.conform === seam.reference) {
            errors.push(
              `${at}.seamReconciliation.linkTarget.conform must be the non-reference edge (opposite of reference)`
            );
          }
        }
      }
    }
  }

  // preview.edges（seam overlay の render geometry）は任意・追加的; 存在するときだけ shape を
  // 検証する。
  const preview = proposal.preview as Record<string, unknown> | undefined;
  if (preview && preview.edges !== undefined) {
    if (!Array.isArray(preview.edges)) {
      errors.push(`${at}.preview.edges must be an array when present`);
    } else {
      preview.edges.forEach((edge, edgeIndex) => {
        if (!isPreviewEdge(edge)) {
          errors.push(`${at}.preview.edges[${edgeIndex}] is not a valid preview edge`);
        }
      });
    }
  }

  // preview.edge（addressing した単一 edge の render geometry、curve_kink）は任意・追加的; 存在する
  // ときだけ shape を検証する。edge は polyline: 有限な net-line point が最低 2 つ。
  if (preview && preview.edge !== undefined) {
    const edge = preview.edge as Record<string, unknown>;
    if (
      typeof edge !== "object" ||
      edge === null ||
      !Array.isArray(edge.points) ||
      edge.points.length < 2 ||
      !edge.points.every(isFinitePoint)
    ) {
      errors.push(`${at}.preview.edge must carry at least two finite net-line points when present`);
    }
  }

  // move-vertex change は addressing した edge の net line の vertex を 1 つ編集するので、proposal は
  // その edge の render geometry（preview.edge）を必ず持たねばならない。無いと、補正は applyable
  // なのに overlay が何も見せない — 人間が見たことのない線を accept でき、「見ていないものを apply
  // しない」を破る。そして動かす vertex は内部でなければならない（endpoint は不可、T7）。ここで
  // cross-check し、preview.edge を欠くか endpoint を指す手編集 proposal が contract を通らないようにする。
  const changeList: unknown[] = Array.isArray(proposal.changes) ? proposal.changes : [];
  const moveVertexChanges = changeList.filter(
    (change): change is Record<string, unknown> =>
      typeof change === "object" &&
      change !== null &&
      (change as Record<string, unknown>).kind === "move-vertex"
  );
  if (moveVertexChanges.length > 0) {
    const edgePoints =
      preview && typeof preview.edge === "object" && preview.edge !== null
        ? (preview.edge as Record<string, unknown>).points
        : undefined;
    if (!Array.isArray(edgePoints) || edgePoints.length < 3) {
      errors.push(
        `${at} has a move-vertex change but no preview.edge with at least 3 net-line points to preview and apply it`
      );
    } else {
      for (const change of moveVertexChanges) {
        const index = change.vertexIndex;
        if (typeof index === "number" && (index <= 0 || index >= edgePoints.length - 1)) {
          errors.push(
            `${at} move-vertex targets vertex ${index}, an endpoint of the ${edgePoints.length}-point edge (T7: never move an endpoint)`
          );
        }
      }
    }
  }
}

// file の required field を検証する。人間が読める error のリストを返す; 空リストは file が v0
// contract を満たすことを意味する。createProposalFile 内の内部 guard としても、test からも使う（T9）。
export function validateProposalFile(file: unknown): string[] {
  const errors: string[] = [];
  if (typeof file !== "object" || file === null) {
    errors.push("proposal file must be an object");
    return errors;
  }
  const proposalFile = file as Record<string, unknown>;

  if (proposalFile.schema !== PROPOSAL_SCHEMA_V0) {
    errors.push(`schema must be "${PROPOSAL_SCHEMA_V0}"`);
  }

  const source = proposalFile.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") {
    errors.push("source is required");
  } else {
    if (!isNonEmptyString(source.file)) errors.push("source.file is required");
    if (!isNonEmptyString(source.sourceDigest)) errors.push("source.sourceDigest is required");
  }

  if (!Array.isArray(proposalFile.proposals)) {
    errors.push("proposals must be an array");
  } else {
    proposalFile.proposals.forEach((proposal, index) => validateProposal(proposal, index, errors));
  }

  if (proposalFile.skipped !== undefined && !Array.isArray(proposalFile.skipped)) {
    errors.push("skipped must be an array when present");
  }

  return errors;
}
