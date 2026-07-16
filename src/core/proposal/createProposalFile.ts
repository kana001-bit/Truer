// Seamlint 形式の diagnostic から、検証済みの `truer.proposal.v0` file を組み立てる。
//
// proposal の *model*。file IO も DXF parsing も持たない: DXF adapter が各 edge の net-line points を
// Seamlint `slnt edges` で解決し、`resolveTarget` / `resolveSeamPair` 経由で渡す。補正 geometry は
// fixes（`src/core/fixes/`）にあり、最小の `changes` を返す; apply と preview はそれを applyChanges で
// 再生する（T2 / T4）。
//
// 対応する diagnostic code は 2 つ、それぞれ builder 1 つ（registry-lite; references/extensibility.md
// E1 の完全な `src/core/fixes/` registry は後回し）:
//   - geometry.curve_kink: 単一 edge + `actual.point`。curveKink fix は確信を持って対応づけた内部
//     vertex を `local-adjustment`（move-vertex、弦への射影）として滑らかにし、endpoint / 対応不能 /
//     退化のケースは `preview-only` に落とす（T7 / T8）。apply は補正済み edge を Truer 所有の DXF に
//     `--out` として書く（M3、2026-07-16）。
//   - geometry.seam_length_mismatch: *ペア* の diagnostic（point 無し; from/to/diff mm）。ペアの
//     "from" edge を anchor にして addressing する。anchor は表示 / addressing 用だけで、どちらの edge を
//     変えるかの主張ではない（T6）。どちらが Δ を吸収するかは未決（人間/Loomit の reference token が
//     要る）なので、今は preview-only のまま。
//
// pure: 同じ入力 -> 同じ出力。ここには時刻・乱数・filesystem アクセスを持たない
//（references/critical-invariants.md T10）。呼び出し側（CLI）が file IO を行い、`sourceText` と
// `resolveTarget` / `resolveSeamPair` の callback を渡す。

import {
  PROPOSAL_SCHEMA_V0,
  SKIP_AMBIGUOUS_TARGET,
  SKIP_MISSING_DIAGNOSTIC_POINT,
  SKIP_MISSING_LENGTH_FIELDS,
  SKIP_TARGET_NOT_FOUND,
  SKIP_UNSUPPORTED_DIAGNOSTIC_CODE,
  isSupportedDiagnosticCode,
  validateProposalFile
} from "./proposalSchema.ts";
import type {
  IntentConfidence,
  Point,
  PreviewEdge,
  Proposal,
  ProposalFile,
  ProposalSource,
  ProposalTarget,
  SeamEdge,
  SeamReconciliation,
  SkippedDiagnostic,
  SourceDiagnostic
} from "./proposalSchema.ts";
import { digestEdgePoints, digestText } from "./proposalDigest.ts";
import { buildCurveKinkFix } from "../fixes/curveKink.ts";

// Truer が読む Seamlint diagnostic の部分集合。この shape を作るのは Seamlint adapter
//（Milestone 3）の責務で、core は Seamlint の厳密な JSON に依存しない。
export interface DiagnosticInput {
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

// diagnostic に対して解決された target edge。DXF addressing: BLOCK 名 + Seamlint `structuralEdges`
// primitive 上の edge、加えて edge の net-line `points`（`slnt edges` 由来、canonical）。
// `points` は `targetDigest` に digest され（digestEdgePoints）、かつ弦への射影のため curve_kink fix に、
// `preview.edge` 経由で overlay に渡される。だから proposal は self-contained。
// DXF adapter が `resolveTarget` 経由で供給する（CLI で結線）。
//
// ペアの diagnostic（seam_length_mismatch）では、adapter がペアの "from" edge を addressing anchor
// として解決する; core は from/to の分け方に関知しない。
export interface ResolvedTarget {
  blockName: string;
  // edgeId / arcRange の少なくとも一方が必要（ProposalTarget と同じ）。
  edgeId?: string;
  arcRange?: [number, number];
  // addressing した edge の net-line 頂点（Seamlint `slnt edges` からの canonical points）。
  points: Point[];
  // `points` 内の kink vertex の正確な index（curve_kink のみ、任意）。Seamlint が
  // actual.edge.vertexIndex に載せているときに使う。curve_kink fix が丸めに敏感な座標一致を省ける;
  // addressing 専用なので ProposalTarget には記録しない（move-vertex change が既に具体的 index を
  // 持つ）。seam ペアや古い report には無い。
  vertexIndex?: number;
}

// diagnostic の target edge を source 内で特定した結果。"not-found" と "ambiguous" は区別する:
// DXF adapter は「複数候補 edge」を「見つからない」に潰してはならない
//（references/critical-invariants.md T6）。曖昧さは実在する上流の状態 — Seamlint は実際の型紙で
// geometry.seam_edge_ambiguous を出す — なので、Truer はそれを target_not_found に誤って報告したり、
// throw して run 全体を失ったりせず、proposal.ambiguous_target として保つ。
export type ResolveTargetResult =
  | { status: "resolved"; target: ResolvedTarget }
  | { status: "not-found" }
  | { status: "ambiguous" };

// 解決された seam ペアの片方の edge: DXF addressing + この edge の net-line points と実測長。
// DXF adapter は seam_length_mismatch の両 edge を、Seamlint の `slnt edges` を呼んで
// `edges[edgeId]` を読むことで解決する（points は `structuralEdges` 由来）。`points` は canonical な
// geometry: `edgeDigest` に digest され、かつ `preview.edges` にそのまま格納されるので、overlay は
// proposal だけから再現できる（self-contained）。`edgeId` は adapter が既に string へ変換済み
//（Seamlint は number で出す）。
export interface ResolvedSeamEdge {
  blockName: string;
  edgeId?: string;
  arcRange?: [number, number];
  points: Point[];
  lengthMm: number;
}

// seam ペアの両 edge を解決した結果。`reference` は Loomit/人間の token が指定したとき、正とする
//（固定）edge を表す; undefined => 未決なので、proposal は両方向を提示する preview-only のまま（T6）。
// not-found / ambiguous は ResolveTargetResult と同じ。
export type SeamPairResolution =
  | {
      status: "resolved";
      fromEdge: ResolvedSeamEdge;
      toEdge: ResolvedSeamEdge;
      reference?: "from" | "to";
    }
  | { status: "not-found" }
  | { status: "ambiguous" };

export interface CreateProposalFileInput {
  // CLI で渡されたユーザー向け source path（source.file にそのまま入る）。
  sourceFile: string;
  // 生の DXF text。source.sourceDigest に digest する。
  sourceText: string;
  diagnostics: DiagnosticInput[];
  // diagnostic の target edge を特定する。resolved / not-found / ambiguous を返し、
  //「そんな edge は無い」と「候補 edge が複数ある」を区別したまま保つ（T6）。
  resolveTarget: (diagnostic: DiagnosticInput) => ResolveTargetResult;
  // seam ペア（seam_length_mismatch）の両 edge を解決する。任意: 無いとき seam builder は
  // 単一 anchor の preview-only 挙動に戻る（pair model なし）。DXF adapter は結線後は常に供給する。
  resolveSeamPair?: (diagnostic: DiagnosticInput) => SeamPairResolution;
  createdBy?: string;
}

// seam length mismatch の confidence 帯。Seamlint は差が既に tolerance を超えたときだけ mismatch を
// 出すので、届く mismatch はすべて「tolerance 超過」。残差が小さければ true-up の妥当な候補
//（medium）; 大きければ意図的なイセ/ギャザーや誤ペアの可能性が高く、人間が判断すべき（low）。
// どちらでも reviewRequired は true のまま。調整可能な policy を 1 箇所にまとめる。
const LENGTH_ADJUST_CANDIDATE_MAX_MM = 10;

export function proposalId(index: number): string {
  return "prop_" + String(index).padStart(3, "0");
}

function isFinitePoint(point: Point | undefined): point is Point {
  return point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}

interface SeamLengths {
  fromLengthMm: number;
  toLengthMm: number;
  lengthDiffMm: number;
}

// seam_length_mismatch が必要とする 3 つの有限な length field を読む。どれかが無い / 非有限なら
// undefined（actual の index signature 下では `unknown` として届く）。
function readSeamLengths(actual: DiagnosticInput["actual"]): SeamLengths | undefined {
  if (!actual) return undefined;
  const { fromLengthMm, toLengthMm, lengthDiffMm } = actual;
  if (typeof fromLengthMm !== "number" || !Number.isFinite(fromLengthMm)) return undefined;
  if (typeof toLengthMm !== "number" || !Number.isFinite(toLengthMm)) return undefined;
  if (typeof lengthDiffMm !== "number" || !Number.isFinite(lengthDiffMm)) return undefined;
  return { fromLengthMm, toLengthMm, lengthDiffMm };
}

// 人間が読める mm、決定的に丸める（notes は説明文であって geometry ではない; proposal が
// byte 安定であり続けるよう決定性を保つ、T10）。
function formatMm(mm: number): string {
  return mm.toFixed(1);
}

function toSourceDiagnostic(diagnostic: DiagnosticInput): SourceDiagnostic {
  // 元の diagnostic data を proposal に保持する（T8）: apply や将来の Studio が、report 無しでも
  //「なぜ」この proposal が在るかを説明できるように。
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    target: diagnostic.target,
    expected: diagnostic.expected,
    actual: diagnostic.actual,
    suggestion: diagnostic.suggestion,
    message: diagnostic.message
  };
}

function buildTarget(target: ResolvedTarget): ProposalTarget {
  return {
    blockName: target.blockName,
    ...(target.edgeId !== undefined ? { edgeId: target.edgeId } : {}),
    ...(target.arcRange !== undefined ? { arcRange: target.arcRange } : {}),
    // seam edge と同じ canonical points digest; digestEdgePoints(preview.edge.points) と一致する。
    targetDigest: digestEdgePoints(target.points)
  };
}

function buildSeamEdge(edge: ResolvedSeamEdge): SeamEdge {
  return {
    blockName: edge.blockName,
    ...(edge.edgeId !== undefined ? { edgeId: edge.edgeId } : {}),
    ...(edge.arcRange !== undefined ? { arcRange: edge.arcRange } : {}),
    edgeDigest: digestEdgePoints(edge.points),
    lengthMm: edge.lengthMm
  };
}

function seamNotes(
  diffMm: number,
  lengths: SeamLengths,
  reference: "from" | "to" | undefined
): string[] {
  const head = `縫い合わせる2辺の長さが ${formatMm(diffMm)} mm 食い違っています (${formatMm(lengths.fromLengthMm)} / ${formatMm(lengths.toLengthMm)} mm)。`;
  const direction =
    reference === undefined
      ? "基準辺が未指定のため、どちらに寄せるかは決めていません（両方向が候補, T6）。"
      : `${reference} 辺を基準（固定）とし、もう片方を ±Δ で合わせる想定です。`;
  return [
    head,
    direction,
    "書き戻し先は未確定 (B: apply 先決定待ち)。意図的なイセ・ギャザーの可能性もあるため人間の確認が必要です。まだ線は引き直していません (preview-only)。"
  ];
}

// diagnostic ごとの proposal builder。各々が proposal か skip 理由のどちらかを返す;
// 予見できる field 欠落で throw しない（T8）。id 採番と skipped リストは loop が持つ。
// diagnostic を足す = builder 1 つ + registry entry 1 つ。
interface BuildContext {
  id: string;
  diagnostic: DiagnosticInput;
  resolveTarget: (diagnostic: DiagnosticInput) => ResolveTargetResult;
  resolveSeamPair?: (diagnostic: DiagnosticInput) => SeamPairResolution;
}

type SkipReason = { code: string; message: string };
type BuildResult = { proposal: Proposal } | { skip: SkipReason };

type ProposalBuilder = (context: BuildContext) => BuildResult;

// 共有: resolveTarget の not-found / ambiguous を skip 理由へ写すか、解決済み edge を返す。
// どちらの code も単一 anchor edge を同じやり方で addressing する。
function resolveTargetOrSkip(
  diagnostic: DiagnosticInput,
  resolveTarget: (diagnostic: DiagnosticInput) => ResolveTargetResult
): { target: ResolvedTarget } | { skip: SkipReason } {
  const resolved = resolveTarget(diagnostic);
  if (resolved.status === "not-found") {
    return {
      skip: {
        code: SKIP_TARGET_NOT_FOUND,
        message: `対象 BLOCK/edge (${diagnostic.target ?? "unknown"}) が DXF 内に見つかりません。`
      }
    };
  }
  if (resolved.status === "ambiguous") {
    // T6: 複数候補で一意に定まらない辺は推測せず、not-found と区別して残す。
    return {
      skip: {
        code: SKIP_AMBIGUOUS_TARGET,
        message: `対象 BLOCK/edge (${diagnostic.target ?? "unknown"}) の候補が複数あり、一意に定まりません。`
      }
    };
  }
  return { target: resolved.target };
}

const buildCurveKinkProposal: ProposalBuilder = ({ id, diagnostic, resolveTarget }) => {
  const point = diagnostic.actual?.point;
  if (!isFinitePoint(point)) {
    return {
      skip: {
        code: SKIP_MISSING_DIAGNOSTIC_POINT,
        message: `診断 ${diagnostic.code} に有効な actual.point が無いため補正候補を作れません。`
      }
    };
  }

  const resolved = resolveTargetOrSkip(diagnostic, resolveTarget);
  if ("skip" in resolved) return resolved;
  const target = resolved.target;

  // mode は fix が決める: 確信を持って対応づけた内部 vertex は local-adjustment（move-vertex、
  // 弦への射影）に; endpoint / 対応不能 / 退化のケースは preview-only のまま（T7 / T8）。どちらでも
  // overlay は edge の net-line points を描き、local-adjustment のときは `changes` を applyChanges で
  // 再生して補正後の line を導く（T2）。補正後 geometry をここで二重計算しない:
  // `preview.edge.points` + `changes` が単一の source。Seamlint が正確な vertexIndex を載せていた
  // ときは、fix はそれを使って座標一致を省く。
  const fix = buildCurveKinkFix({
    points: target.points,
    diagnosticPoint: point,
    ...(target.vertexIndex !== undefined ? { vertexIndex: target.vertexIndex } : {})
  });

  return {
    proposal: {
      id,
      status: "proposed",
      mode: fix.mode,
      target: buildTarget(target),
      sourceDiagnostic: toSourceDiagnostic(diagnostic),
      intent: fix.intent,
      changes: fix.changes,
      preview: {
        diagnosticPoint: { x: point.x, y: point.y },
        edge: { points: target.points }
      },
      notes: fix.notes
    }
  };
};

const buildSeamLengthMismatchProposal: ProposalBuilder = ({
  id,
  diagnostic,
  resolveTarget,
  resolveSeamPair
}) => {
  const lengths = readSeamLengths(diagnostic.actual);
  if (!lengths) {
    return {
      skip: {
        code: SKIP_MISSING_LENGTH_FIELDS,
        message: `診断 ${diagnostic.code} に有効な fromLengthMm / toLengthMm / lengthDiffMm が無いため補正候補を作れません。`
      }
    };
  }

  const diffMm = Math.abs(lengths.lengthDiffMm);
  const confidence: IntentConfidence = diffMm <= LENGTH_ADJUST_CANDIDATE_MAX_MM ? "medium" : "low";

  // ペア対応の経路: 両 edge を解決して proposal がペア全体（各 edge 自身の digest）を記録し、
  // decision 2（reference に合わせる: reference / 調整 / Δ）を model 化する。相方の digest を記録すると
  // anchor だけ digest していた穴が塞がる — 将来の apply が両 edge で gate できる。まだ preview-only:
  // apply の書き先（.val か DXF か）は未決なので `changes` は空のまま、線は引かない。`target` は
  // "from" edge を addressing し続ける; ペアの真実は seamReconciliation にある。reference が指定
  // されていないとき、向きは未決のまま両方向を提示する（T6）。
  if (resolveSeamPair) {
    const pair = resolveSeamPair(diagnostic);
    if (pair.status === "not-found") {
      return {
        skip: {
          code: SKIP_TARGET_NOT_FOUND,
          message: `対象 BLOCK/edge (${diagnostic.target ?? "unknown"}) が DXF 内に見つかりません。`
        }
      };
    }
    if (pair.status === "ambiguous") {
      return {
        skip: {
          code: SKIP_AMBIGUOUS_TARGET,
          message: `対象 BLOCK/edge (${diagnostic.target ?? "unknown"}) の候補が複数あり、一意に定まりません。`
        }
      };
    }

    const fromSeamEdge = buildSeamEdge(pair.fromEdge);
    const toSeamEdge = buildSeamEdge(pair.toEdge);
    const seamReconciliation: SeamReconciliation = {
      fromEdge: fromSeamEdge,
      toEdge: toSeamEdge,
      deltaMm: diffMm,
      ...(pair.reference !== undefined ? { reference: pair.reference } : {})
    };

    // target は依然 "from" edge を addressing する（表示 anchor であって、どちらを変えるかの主張では
    // ない）。その digest は from edge 自身の points digest なので、target と seamReconciliation は
    // 一致する。
    const target: ProposalTarget = {
      blockName: pair.fromEdge.blockName,
      ...(pair.fromEdge.edgeId !== undefined ? { edgeId: pair.fromEdge.edgeId } : {}),
      ...(pair.fromEdge.arcRange !== undefined ? { arcRange: pair.fromEdge.arcRange } : {}),
      targetDigest: fromSeamEdge.edgeDigest
    };

    // overlay 用の render geometry: 両 edge の net-line points を、preview が proposal の純粋関数に
    // なるようそのまま格納する（self-contained; DXF / Seamlint を呼び直さない）。構成上
    // digestEdgePoints(points) === 対応する seamReconciliation edge の edgeDigest（どちらも同じ points
    // から来る）。まだ preview-only: 補正後の line は無い。
    const previewEdges: PreviewEdge[] = [
      { role: "from", points: pair.fromEdge.points },
      { role: "to", points: pair.toEdge.points }
    ];

    return {
      proposal: {
        id,
        status: "proposed",
        mode: "preview-only",
        target,
        sourceDiagnostic: toSourceDiagnostic(diagnostic),
        intent: { kind: "reconcile-seam-length", confidence, reviewRequired: true },
        changes: [],
        preview: { edges: previewEdges },
        notes: seamNotes(diffMm, lengths, pair.reference),
        seamReconciliation
      }
    };
  }

  // Fallback（まだ pair resolver が渡されていない）: 単一 anchor の preview-only、pair model なし。
  // 後方互換; resolveSeamPair が結線されるまで、file 全体の source.sourceDigest gate（T3）が相方 edge
  // へのあらゆる編集を依然として捕らえる。
  const resolved = resolveTargetOrSkip(diagnostic, resolveTarget);
  if ("skip" in resolved) return resolved;

  return {
    proposal: {
      id,
      status: "proposed",
      mode: "preview-only",
      target: buildTarget(resolved.target),
      sourceDiagnostic: toSourceDiagnostic(diagnostic),
      intent: { kind: "reconcile-seam-length", confidence, reviewRequired: true },
      changes: [],
      preview: {},
      notes: [
        `縫い合わせる2辺の長さが ${formatMm(diffMm)} mm 食い違っています (${formatMm(lengths.fromLengthMm)} / ${formatMm(lengths.toLengthMm)} mm)。`,
        "どちらの辺に差を寄せるか、および書き戻し先は未確定です (B: apply 先決定待ち)。",
        "意図的なイセ・ギャザーの可能性もあるため人間の確認が必要です。まだ線は引き直していません (preview-only)。"
      ]
    }
  };
};

const PROPOSAL_BUILDERS: Record<string, ProposalBuilder> = {
  "geometry.curve_kink": buildCurveKinkProposal,
  "geometry.seam_length_mismatch": buildSeamLengthMismatchProposal
};

function skip(code: string, diagnostic: DiagnosticInput, message: string): SkippedDiagnostic {
  return {
    code,
    diagnosticCode: diagnostic.code,
    message,
    diagnostic
  };
}

export function createProposalFile(input: CreateProposalFileInput): ProposalFile {
  const source: ProposalSource = {
    file: input.sourceFile,
    sourceDigest: digestText(input.sourceText),
    createdBy: input.createdBy ?? "tru propose"
  };

  const proposals: Proposal[] = [];
  const skipped: SkippedDiagnostic[] = [];

  for (const diagnostic of input.diagnostics) {
    const builder = isSupportedDiagnosticCode(diagnostic.code)
      ? PROPOSAL_BUILDERS[diagnostic.code]
      : undefined;
    if (!builder) {
      skipped.push(
        skip(
          SKIP_UNSUPPORTED_DIAGNOSTIC_CODE,
          diagnostic,
          `診断コード ${diagnostic.code} は現在の Truer が扱う補正対象ではありません。`
        )
      );
      continue;
    }

    // 候補 id は proposals.length + 1; skip された diagnostic は消費しないので、成功した proposal
    // 間で id は安定・連番のまま。
    const result = builder({
      id: proposalId(proposals.length + 1),
      diagnostic,
      resolveTarget: input.resolveTarget,
      resolveSeamPair: input.resolveSeamPair
    });

    if ("skip" in result) {
      skipped.push(skip(result.skip.code, diagnostic, result.skip.message));
      continue;
    }

    proposals.push(result.proposal);
  }

  const file: ProposalFile = {
    schema: PROPOSAL_SCHEMA_V0,
    source,
    proposals,
    skipped
  };

  // Guard: 自分の contract を満たさない file は決して emit しない。
  const errors = validateProposalFile(file);
  if (errors.length > 0) {
    throw new Error("createProposalFile produced an invalid proposal file: " + errors.join("; "));
  }

  return file;
}
