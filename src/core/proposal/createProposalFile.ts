// Seamlint 形式の diagnostic から、検証済みの `truer.proposal.v0` file を組み立てる。
//
// proposal の *model*。file IO も DXF parsing も持たない: DXF adapter が各 edge の net-line points を
// Seamlint `slnt edges` で解決し、`resolveTarget` / `resolveSeamPair` 経由で渡す。補正 geometry は
// fixes（`src/core/fixes/`）にあり、最小の `changes` を返す; apply と preview はそれを applyChanges で
// 再生する（T2 / T4）。
//
// 対応する diagnostic code は 3 つ、それぞれ builder 1 つ（registry-lite; references/extensibility.md
// E1 の完全な `src/core/fixes/` registry は後回し）:
//   - geometry.curve_kink: 単一 edge + `actual.point`。curveKink fix は確信を持って対応づけた内部
//     vertex を `local-adjustment`（move-vertex、弦への射影）として滑らかにし、endpoint / 対応不能 /
//     退化のケースは `preview-only` に落とす（T7 / T8）。apply は補正済み edge を Truer 所有の DXF に
//     `--out` として書く（M3、2026-07-16）。
//   - geometry.seam_length_mismatch: *ペア* の diagnostic（point 無し; from/to/diff mm）。ペアの
//     "from" edge を anchor にして addressing する。anchor は表示 / addressing 用だけで、どちらの edge を
//     変えるかの主張ではない（T6）。どちらが Δ を吸収するかは未決（人間/Loomit の reference token が
//     要る）なので、今は preview-only のまま。
//   - geometry.band_seam_sum_mismatch: *N-ary* の band 診断（band 総周長 ↔ Σ隣接ピース仕上がり辺）。
//     `actual.bandEdge` で band 辺を addressing し、neighbours は住所+数値を運ぶ。`--reference` で band か
//     neighbours を固定して band が conform のとき band 長目標を出す。preview-only（bandReconciliation）。
//
// pure: 同じ入力 -> 同じ出力。ここには時刻・乱数・filesystem アクセスを持たない
//（references/critical-invariants.md T10）。呼び出し側（CLI）が file IO を行い、`sourceText` と
// `resolveTarget` / `resolveSeamPair` / `resolveBandSeam` の callback を渡す。

import {
  PROPOSAL_SCHEMA_V0,
  SKIP_AMBIGUOUS_TARGET,
  SKIP_MISSING_BAND_FIELDS,
  SKIP_MISSING_DIAGNOSTIC_POINT,
  SKIP_MISSING_LENGTH_FIELDS,
  SKIP_TARGET_NOT_FOUND,
  SKIP_UNSUPPORTED_DIAGNOSTIC_CODE,
  isSupportedDiagnosticCode,
  validateProposalFile
} from "./proposalSchema.ts";
import type {
  BandNeighbor,
  BandReconciliation,
  CornerSlide,
  CornerSlideCandidate,
  IntentConfidence,
  LinkTarget,
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
import { solveCornerSlide } from "../fixes/cornerSlide.ts";
import { roundCoord } from "../geometry-edit/index.ts";

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
// 角を共有する同 BLOCK の隣辺（ループ順 k±1）。②corner-slide の solve にだけ使う軽量ビュー。
export interface SeamEdgeNeighbor {
  edgeId?: string;
  points: Point[];
}

export interface ResolvedSeamEdge {
  blockName: string;
  edgeId?: string;
  arcRange?: [number, number];
  points: Point[];
  lengthMm: number;
  // start = points[0]（始点角）を共有する隣辺 / end = points[最後]（終点角）を共有する隣辺。
  // 任意（additive）: 供給が無ければ corner-slide を solve しないだけで、①structural-link 経路は不変。
  neighbors?: { start?: SeamEdgeNeighbor; end?: SeamEdgeNeighbor };
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

// band_seam_sum_mismatch の隣接ピース 1 枚（住所 + finished + cut）。`points` は overlay に neighbour 辺を
// 「形」で描くための net-line polyline（band 辺と同型に slnt edges から解決）。任意・追加的: 解決できない
// neighbour（辺が無い / slnt 失敗 / 住所が edgeId 無し）は points 無し = 描かないだけ（数値は残す, T8）。
export interface ResolvedBandNeighbor {
  blockName: string;
  edgeId?: string;
  arcRange?: [number, number];
  finishedLengthMm: number;
  cutQuantity: number;
  points?: Point[];
}

// band 診断を解決した結果。band 辺は住所から net-line points まで解決し（digest / preview 用）、
// neighbours は住所+数値のまま運ぶ。`reference` は `--reference` の blockName 集合と band/neighbour を
// 照合して決める: "band"（band 固定・neighbours を直す）/ "neighbours"（band が conform・目標長あり）/
// undefined（両方向 preview-only, T6）。measured 値（bandTotal/sum/closure）は診断から来る。
export type BandSeamResolution =
  | {
      status: "resolved";
      bandEdge: ResolvedSeamEdge; // lengthMm = band 辺 1 枚の finished 長（= bandLengthMm）
      bandCutQuantity: number;
      bandTotalMm: number;
      sumMm: number;
      closureMm: number;
      closurePct: number;
      neighbours: ResolvedBandNeighbor[];
      reference?: "band" | "neighbours";
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
  // band 診断（band_seam_sum_mismatch）を解決する。任意: 無い / bandEdge 欠落なら band builder は
  // 理由付き skip（推測しない）。DXF adapter は結線後は常に供給する。
  resolveBandSeam?: (diagnostic: DiagnosticInput) => BandSeamResolution;
  createdBy?: string;
}

// seam length mismatch の confidence 帯。Seamlint は差が既に tolerance を超えたときだけ mismatch を
// 出すので、届く mismatch はすべて「tolerance 超過」。残差が小さければ true-up の妥当な候補
//（medium）; 大きければ意図的なイセ/ギャザーや誤ペアの可能性が高く、人間が判断すべき（low）。
// どちらでも reviewRequired は true のまま。調整可能な policy を 1 箇所にまとめる。
const LENGTH_ADJUST_CANDIDATE_MAX_MM = 10;

// band closure（|bandTotal − sum| / sum）の confidence 帯。Seamlint は closure が許容（既定 6%）を
// 超えたときだけ sum-mismatch を出すので、届くのは全て許容超。残差が小さければ true-up 候補（medium）、
// 大きければ gather/tuck や集合違いの疑いが濃く人間判断（low）。どちらでも reviewRequired は true。
const BAND_CLOSURE_CANDIDATE_MAX_RATIO = 0.1;

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
  reference: "from" | "to" | undefined,
  easeMm: number,
  targetFinishedMm: number | undefined,
  cornerSlide: CornerSlide | undefined
): string[] {
  const head = `縫い合わせる2辺の長さが ${formatMm(diffMm)} mm 食い違っています (${formatMm(lengths.fromLengthMm)} / ${formatMm(lengths.toLengthMm)} mm、宣言 ease=${formatMm(easeMm)})。`;
  const recommend =
    "推奨は①構造リンク: Valentina の構築で2辺の長さをリンク（VLineLength / VIncrement で配線）し、宣言差（ease、0 なら等長）を保てば、構築で保証され再発しません。";
  const direction =
    reference === undefined
      ? "どちらの辺を固定（基準）にするかが未指定のため、目標長は未確定です（両方向が候補, T6）。"
      : targetFinishedMm === undefined
        ? "基準辺は指定済みですが、宣言 ease の向き（どちらを長くするか）が現状の測定差から決まらないため、目標長は保留です。"
        : `${reference} 辺を固定し、${reference === "from" ? "to" : "from"} 辺の finished 長を ${formatMm(targetFinishedMm)} mm に合わせてください。`;
  const lines = [head, recommend, direction];

  // ②corner-slide の指示ログ（決定木の 2 行目）。①リンクが過拘束（両端が landmark 固定）だったり
  // 今すぐ裁ちたいときの fallback として、解けた角候補を人へ渡す。角の xy は出さない（V2: 目標長と
  // スライド量だけ）。
  if (cornerSlide !== undefined) {
    if (cornerSlide.candidates.length > 0) {
      const options = cornerSlide.candidates
        .map(
          (candidate) =>
            `${candidate.corner === "start" ? "始点" : "終点"}角を辺 ${candidate.slideAlong.edgeId} に沿って ${formatMm(candidate.slideDistanceMm)} mm（隣辺長 ${formatMm(candidate.neighborLengthChange.fromMm)}→${formatMm(candidate.neighborLengthChange.toMm)} mm）`
        )
        .join(" / ");
      lines.push(
        `①のリンクが過拘束になる・今すぐ裁つ、なら②corner-slide: ${options}。どの角で吸うかは低カップリング（よく合っている seam を壊さない角）を人が選んでください（Truer は決めません）。`,
        "②はその場限りです（val 未リンクのままなら再生成で再発。恒久解は①のみ）。角スライドで notch 位置もずれうるため、当てたら再エクスポート→Seamlint 再チェックを。"
      );
    } else {
      lines.push(
        "②corner-slide はこの辺では解けません（隣辺が曲線、または幾何的に解なし）。候補は①構造リンクのみです。"
      );
    }
  }

  lines.push(
    "Truer は目標を提案するだけ（advisory）で、val は人が Valentina で当てます。当てたら再エクスポート→Seamlint で確認を。意図的なイセ・ギャザーなら ease を宣言してください。まだ線は引き直していません (preview-only)。"
  );
  return lines;
}

// band 診断の人間可読な指示ログ。①structural-link（band を Σ隣接に構築でリンク）を推す。band には
// ②corner-slide は当たらない（バンドは長辺 1 本を隣接合計へ合わせる N-ary で、角スライドの局所解が無い）。
function bandNotes(band: BandReconciliation): string[] {
  const head = `バンド総周長 ${formatMm(band.bandTotalMm)} mm と隣接ピース合計 ${formatMm(band.sumMm)} mm が ${formatMm(Math.abs(band.closureMm))} mm 食い違っています（closure ${formatMm(band.closurePct * 100)}%、バンド長辺 ${formatMm(band.bandEdge.lengthMm)} mm × ${band.bandCutQuantity} 枚）。`;
  const recommend =
    "推奨は①構造リンク: Valentina の構築でバンド周長を隣接ピースの仕上がり辺合計にリンクし、宣言 closure（0 なら等長）を保てば、構築で保証され再発しません。";
  const direction =
    band.reference === undefined
      ? "band と neighbours のどちらを固定（基準）にするかが未指定のため、目標長は未確定です（両方向が候補, T6）。"
      : band.reference === "neighbours"
        ? `neighbours を固定し、バンド長辺の finished 長を ${formatMm(band.targetBandLengthMm ?? 0)} mm（= 隣接合計 ÷ ${band.bandCutQuantity} 枚 + 宣言 closure）に合わせてください。`
        : "band を固定し、隣接ピース側の仕上がり辺合計をバンド周長に合わせてください（N-ary なので各ピースへの配分は人が決めます）。";
  return [
    head,
    recommend,
    direction,
    "Truer は目標を提案するだけ（advisory）で、val は人が Valentina で当てます。当てたら再エクスポート→Seamlint で確認を。gather/tuck など意図的な closure なら宣言してください。まだ線は引き直していません (preview-only)。"
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
  resolveBandSeam?: (diagnostic: DiagnosticInput) => BandSeamResolution;
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

    // 宣言 ease。Seamlint diagnostic が connector 由来の ease を運ぶまでは既定 0（＝揃うべき）。
    const declaredEase = diagnostic.actual?.easeMm;
    const easeMm =
      typeof declaredEase === "number" && Number.isFinite(declaredEase) && declaredEase >= 0
        ? declaredEase
        : 0;

    // ①structural-link の推奨。reference が決まっていれば conform 側（reference の反対辺）と目標 finished
    // 長を渡す。目標長は宣言 ease を保つよう、固定辺長から現在の差の向きへ ease ぶん残す（ease=0 なら固定辺
    // 長＝等長）＝ minimal-change で宣言 ease を潰さない。ease の「向き」を connector が宣言するまでは現在の
    // 測定差の符号を採る。reference の供給源は CLI `--reference`（実装済み。adapter が診断の from/to の
    // blockName と照合して pair.reference を決める）; connector 宣言は将来。core はここで pair.reference を
    // そのまま使うだけ（pure）。まだ preview-only（changes は空）。
    let linkTarget: LinkTarget | undefined;
    if (pair.reference !== undefined) {
      const conform = pair.reference === "from" ? "to" : "from";
      const referenceLen = pair.reference === "from" ? fromSeamEdge.lengthMm : toSeamEdge.lengthMm;
      const conformLen = pair.reference === "from" ? toSeamEdge.lengthMm : fromSeamEdge.lengthMm;
      const direction = Math.sign(conformLen - referenceLen); // -1 / 0 / +1
      // ease>0 かつ測定差 0（direction===0＝符号が採れない）は向きが決まらないので、目標長を捏造せず
      // linkTarget を出さない（T8）。ease=0 は向き不要（目標＝固定辺長＝等長）。
      if (easeMm === 0 || direction !== 0) {
        linkTarget = { conform, targetFinishedMm: referenceLen + direction * easeMm };
      }
    }

    // ②corner-slide（fallback）の指示ログ。①linkTarget と同じゲート（reference 決定済みで目標長が
    // 決まる）でだけ出す。conform 辺の両角を start→end の固定順で solve し（決定的, T10）、解けた角
    // だけ候補にする。どの角で吸うかは人が選ぶ（couplingClass は seam グラフ未供給の間 "unknown",
    // V1）。candidates が空 = どの角も解けない（曲線隣辺 / 幾何的に解なし）ことの明示。数値は emit
    // 境界のここで丸める（roundCoord = EMIT_DECIMALS）。Δ(finished)=Δ(raw)（dart は辺内側）なので
    // finished 目標との差をそのまま raw の polyline に適用できる。
    let cornerSlide: CornerSlide | undefined;
    if (linkTarget !== undefined) {
      const conformResolved = linkTarget.conform === "from" ? pair.fromEdge : pair.toEdge;
      const conformLen =
        linkTarget.conform === "from" ? fromSeamEdge.lengthMm : toSeamEdge.lengthMm;
      const signedDeltaMm = linkTarget.targetFinishedMm - conformLen;
      const candidates: CornerSlideCandidate[] = [];
      for (const corner of ["start", "end"] as const) {
        const neighbor = conformResolved.neighbors?.[corner];
        if (!neighbor || neighbor.edgeId === undefined) continue;
        const solved = solveCornerSlide({
          edgePoints: conformResolved.points,
          corner,
          neighborPoints: neighbor.points,
          deltaMm: signedDeltaMm
        });
        if (!solved.ok) continue;
        candidates.push({
          corner,
          slideAlong: { blockName: conformResolved.blockName, edgeId: neighbor.edgeId },
          couplingClass: "unknown",
          slideDistanceMm: roundCoord(solved.slideDistanceMm),
          neighborLengthChange: {
            fromMm: roundCoord(solved.neighborLengthBeforeMm),
            toMm: roundCoord(solved.neighborLengthAfterMm)
          }
        });
      }
      cornerSlide = {
        conform: linkTarget.conform,
        targetFinishedMm: linkTarget.targetFinishedMm,
        candidates,
        // 角スライドは notch 位置を動かし notch 署名ペアリングが揺れうる（V3）。滑らせる候補が
        // 実在するときだけ意味を持つ warning なので、候補ゼロなら false。
        pairingMayDrift: candidates.length > 0
      };
    }

    const seamReconciliation: SeamReconciliation = {
      fromEdge: fromSeamEdge,
      toEdge: toSeamEdge,
      deltaMm: diffMm,
      easeMm,
      fixKind: "structural-link",
      ...(pair.reference !== undefined ? { reference: pair.reference } : {}),
      ...(linkTarget !== undefined ? { linkTarget } : {}),
      ...(cornerSlide !== undefined ? { cornerSlide } : {})
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
        notes: seamNotes(
          diffMm,
          lengths,
          pair.reference,
          easeMm,
          linkTarget?.targetFinishedMm,
          cornerSlide
        ),
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

const buildBandSeamMismatchProposal: ProposalBuilder = ({ id, diagnostic, resolveBandSeam }) => {
  // resolver 未供給 / bandEdge 欠落（旧 Seamlint report）なら推測せず skip（T6/T8）。band は住所無しに
  // 辺を addressing できない。
  if (!resolveBandSeam) {
    return {
      skip: {
        code: SKIP_MISSING_BAND_FIELDS,
        message: `band 診断 ${diagnostic.code} を解決する手段がありません（bandEdge 住所が必要）。`
      }
    };
  }
  const band = resolveBandSeam(diagnostic);
  if (band.status === "not-found") {
    return {
      skip: {
        code: SKIP_MISSING_BAND_FIELDS,
        message: `band 辺 (${diagnostic.target ?? "unknown"}) を解決できません（bandEdge 住所欠落、または DXF に無い）。`
      }
    };
  }
  if (band.status === "ambiguous") {
    return {
      skip: {
        code: SKIP_AMBIGUOUS_TARGET,
        message: `band 辺 (${diagnostic.target ?? "unknown"}) の候補が複数あり、一意に定まりません。`
      }
    };
  }

  const bandEdge = buildSeamEdge(band.bandEdge);
  const neighbours: BandNeighbor[] = band.neighbours.map((neighbour) => ({
    blockName: neighbour.blockName,
    ...(neighbour.edgeId !== undefined ? { edgeId: neighbour.edgeId } : {}),
    ...(neighbour.arcRange !== undefined ? { arcRange: neighbour.arcRange } : {}),
    finishedLengthMm: neighbour.finishedLengthMm,
    cutQuantity: neighbour.cutQuantity
  }));

  // 宣言 closure（既定 0）。診断が connector 由来の closure を運ぶまでは 0（＝ぴったり sumMm に揃える）。
  const declaredClosure = diagnostic.actual?.declaredClosureMm;
  const declaredClosureMm =
    typeof declaredClosure === "number" && Number.isFinite(declaredClosure) && declaredClosure >= 0
      ? declaredClosure
      : 0;

  // band conform（reference==="neighbours"）のときだけ数値目標を出す。sumMm は全 neighbour 合計＝
  // 絶対目標なので、pairwise のような向きの曖昧さは無い（band 固定 / 未決では目標を出さない, T6）。
  let targetBandLengthMm: number | undefined;
  if (band.reference === "neighbours" && band.bandCutQuantity > 0) {
    targetBandLengthMm = roundCoord((band.sumMm + declaredClosureMm) / band.bandCutQuantity);
  }

  const bandReconciliation: BandReconciliation = {
    bandEdge,
    bandCutQuantity: band.bandCutQuantity,
    bandTotalMm: band.bandTotalMm,
    sumMm: band.sumMm,
    closureMm: band.closureMm,
    closurePct: band.closurePct,
    neighbours,
    declaredClosureMm,
    fixKind: "structural-link",
    ...(band.reference !== undefined ? { reference: band.reference } : {}),
    ...(targetBandLengthMm !== undefined ? { targetBandLengthMm } : {})
  };

  // target は band 辺を addressing する。digest は band 辺自身の points digest なので bandEdge と一致。
  const target: ProposalTarget = {
    blockName: band.bandEdge.blockName,
    ...(band.bandEdge.edgeId !== undefined ? { edgeId: band.bandEdge.edgeId } : {}),
    ...(band.bandEdge.arcRange !== undefined ? { arcRange: band.bandEdge.arcRange } : {}),
    targetDigest: bandEdge.edgeDigest
  };

  // preview: band 辺（role "band"）に加え、points が解決できた neighbour 辺を role "neighbour" で描く
  // （overlay に「形」でも見せる）。band 辺は self-contained: digestEdgePoints(points) === bandEdge.edgeDigest。
  // neighbour 辺は表示補助で digest を持たない。解決できない neighbour は積まない（描かないだけ, T8）。
  // まだ preview-only（補正線は無い）。順序は band → band.neighbours の並び（決定的, T10）。
  const previewEdges: PreviewEdge[] = [{ role: "band", points: band.bandEdge.points }];
  for (const neighbour of band.neighbours) {
    if (neighbour.points && neighbour.points.length >= 2) {
      previewEdges.push({ role: "neighbour", points: neighbour.points });
    }
  }

  return {
    proposal: {
      id,
      status: "proposed",
      mode: "preview-only",
      target,
      sourceDiagnostic: toSourceDiagnostic(diagnostic),
      // closure（隣接合計との差の割合）が大きいほど gather/tuck や集合違いの疑いが濃く、人間判断（low）。
      intent: {
        kind: "reconcile-band-seam",
        confidence: band.closurePct <= BAND_CLOSURE_CANDIDATE_MAX_RATIO ? "medium" : "low",
        reviewRequired: true
      },
      changes: [],
      preview: { edges: previewEdges },
      notes: bandNotes(bandReconciliation),
      bandReconciliation
    }
  };
};

const PROPOSAL_BUILDERS: Record<string, ProposalBuilder> = {
  "geometry.curve_kink": buildCurveKinkProposal,
  "geometry.seam_length_mismatch": buildSeamLengthMismatchProposal,
  "geometry.band_seam_sum_mismatch": buildBandSeamMismatchProposal
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
      resolveSeamPair: input.resolveSeamPair,
      resolveBandSeam: input.resolveBandSeam
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
