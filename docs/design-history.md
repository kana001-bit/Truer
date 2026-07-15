# Truer Design History

この文書は、Truer の設計がどう決まってきたかを残すための記録である。

ここに残したいのは「最初から正しかった設計」の一覧ではない。何を一番恐れて、その恐れから
どんな invariant を引き出し、どこで方向を変え、変えるときに何を守ったか——それを後から
読み返せるようにすることが目的である。Truer は Seamlint や Loomit と違って型紙の線そのものを
書き換える道具なので、設計判断のほとんどは「速く・賢く直す」より「間違って直さない」ための
選択になっている。この文書はその選択の記録でもある。

## この文書の書き足しかた

（future-self へ）新しい設計判断や方向転換が出たら、この下に節を足していく。書きぶりは
Loomit の `design-history.md` に倣う——「どこで違和感／摩擦が出たか → 何を試したか → 何を
棄てて、なぜ棄てたか → どう決着したか」の順に、箇条書きではなく地の文で。方向転換には日付を
頭に付ける（例：`## 【2026-07-11】…`）。確定した判断は本文へ、まだ決めきれていないものは
末尾の「まだ途中にあるもの」へ置く。完成した正解を書く場所ではないので、迷った跡や棄てた案
こそ残す。

## 一番重い失敗は crash ではなく「見たつもりの適用」だった

Truer を作るとき、最初に決めたのは機能ではなく、一番避けたい失敗のかたちだった。

Truer が編集する線は、最終的に布の裁断になる。だからこの道具のいちばん重い失敗は、落ちること
（crash）ではない。**人が「見たつもりで、実は見ていない」補正を、見たつもりのまま適用して
しまうこと**だ。ただ間違える validator は時間を無駄にするだけだが、未レビューの編集を黙って
書く fixer は、布を無駄にし、体に合わない服を通してしまう。

この一つのリスクが、そのあとの設計をほぼ全部決めた。以降の invariant は「賢さ」ではなく、
この失敗を機構で潰すための防御として並んでいる。Truer は、自分が何をするかについて
**構造的に嘘をつけない**ように作る——この方針をここで固定した。

## だから役割を先に、中身より前に固定した

Truer 単体で「見つけて・直して・決める」を全部やろうとすると、境界が曖昧になる。そこで内部
実装を作る前に、三つの道具で仕事を割った。

- **発見は Seamlint** — 幾何を測って「この線は少しおかしいかもしれない」と言う。
- **提案と書き込みは Truer** — 直し方の候補を作り、人が採ったものだけを新しいファイルに書く。
- **採用の判断は人** — 何を実際に変えるかは人が決める。

型紙の線を実際に書き換えるのは三つのうち Truer だけで、だからこそ Truer だけが特別に臆病に
作られている。この境界を中身より先に決めたことで、「Seamlint の `severity` は"見て"の合図で
あって"直してよい"の許可ではない」という後段の invariant が自然に置けた。

## preview は嘘をつけないようにした（核）

ここが Truer の核である。preview に描く「補正後の線」は、`apply` が実際に書く geometry と
1バイトも違ってはいけない。

素朴には、preview 用に「だいたいこうなる」線を別に計算したくなる。だがそれをやると preview と
apply がわずかにずれうる——そしてそのズレこそが「見たつもりで見ていない」の温床になる。だから
両者を別々に計算しない。preview の線も apply の線も、**同じ proposal の同じ `changes` から、
同じ単一の関数**を通して作る。ドリフトしうる第二の近似計算は存在させない。

もう一つ。`changes` が空の proposal（＝まだ直し方を確信できていないもの）では、**青い「補正後の
線」を描かない**。存在しない補正を、あるように見せないためだ。「見えたものが、そのまま書かれる」
を機構で保証する——これが preview==apply。設計として一番きれいで、この道具の思想が一番伝わる
部分でもある。

## source は戻せないから、書き込みを臆病に設計した

source（設計データ）は一度壊すと戻せない。だから書き込み側は徹底して臆病に設計した。

- `propose` は source を絶対に触らない（read-only）。
- `apply` は `--out` にだけ書く。in-place 上書きはしない（`--out` が source と同じなら error）。
  MVP でも in-place write は入れない。
- 書き込みは atomic（temp に書いてから rename）。途中で落ちても、壊れた source が残らない。
- `apply` が当てるのは、人が明示的に accept した proposal id だけ（`--accepted` で指定したもの）。
  繰り返すが、`severity` は「見て」の合図で、適用許可ではない。
- 1バイト書く前に digest を検証する。propose 時に記録した source と対象辺の digest が、apply
  時点で食い違っていたら（＝下で型紙が動いていたら）、書かずに fail する。

## proposal を下流との契約にした

proposal は表示のための一時データではなく、下流との**契約**として設計した。

- proposal は self-contained。`apply` は fix solver を再実行せず、記録済みの `changes` を
  そのまま実行するだけにする。版差や非決定性で preview と別の線が出るのを防ぐためだ。
- schema `truer.proposal.v0` を機械可読な契約として固定した。未知の change kind や version を
  黙って skip（silent skip）せず、明示的に error にする。skip する場合も理由を付けて残す——
  黙って捨てない。
- `schema` / `id` / `status` / `target` / `changes` / `sourceDiagnostic` といったフィールドは、
  表示都合で rename しない。将来 Loomit Studio がこの JSON を読むからだ。

## 自信ありげな間違いを作らないと決めた

「自信ありげな間違い」は、見える false positive よりたちが悪い。だから確信の持てない補正は、
無理に線を引かず preview-only + `confidence: low` に落とす。

- **端点は単体で動かさない**（first slice の線引き）。端点は縫い合わせ・閉じ・ノッチの意味を
  持つ。first slice で自動補正するのは辺の**内部**の kink だけで、端点に関わる diagnostic は
  preview-only にする。滑らかさは端点と接線をセットで考える必要があり、first slice には重すぎる
  と判断した。
- **変更は最小・局所**（vertex の近傍だけ）に留める。全体を再整形して round-trip を壊さない。
  巨大な diff はレビュー不能だし、無関係な頂点の変化が紛れ込む。
- **補正計算は決定的**にし、丸めは emit の1箇所だけにする。非決定だと fixture test も
  preview==apply も壊れる。

## 【2026-07-11】geometry source を SVG から DXF(ASTM) に切り替えた

最初、Seamlint から Truer が受け取る幾何は SVG を前提にしていた。だが 2026-07-11 に、geometry
source を **DXF(ASTM)** に切り替えた。この pivot 自体は Loomit / Seamlint 側の判断とも揃って
いる——SVG は detail identity や notch を落としてしまい、DXF(ASTM) は geometry と identity を
結び付けられるからだ。SVG は legacy に降格した。

切り替えで一番気をつけたのは、「何を変えて、何を守るか」をはっきり分けることだった。

- **addressing を作り直した。** 補正対象の指し方を、SVG の path id から **BLOCK 名 + `edgeId` /
  `arcRange`**（Seamlint の `structuralEdges`）へ再設計した。これは Loomit の
  `connector.path_ref`（＝DXF BLOCK 名）とも Seamlint の `edgeId` とも同じ語彙で、3者で言葉が
  揃う。
- **安全モデルは載せ替えた。** 上の「見たつもりの適用を作らない」系の invariant（propose
  read-only / preview==apply / accept+digest / preview-only / self-contained / schema=contract）
  は、どれも幾何フォーマットに依存しない。だから format を替えても不変に保ったまま、DXF の上に
  載せ替えるだけにした。
- **DXF ゆえに OPEN になった所を、正直に OPEN にした。** DXF の net line は制御点の無い
  flattened polyline なので、curve_kink をどう「補正」するかの editing surface が確定できない。
  ここは無理に線を作らず、first slice では preview-only に倒す。「わからないものは自動修正
  しない」が、この format で特に効く。
- **schema break の扱いを決めた。** addressing を変えると proposal schema が壊れる（break）が、
  まだ誰もこの proposal を consume していない。だから version を v1 に上げるのではなく、
  **v0 を作り直す**と判断した。

## 【2026-07-14】Seamlint の幾何をどう受け取るか — 速さより境界を選んだ

pivot のあと、Truer が Seamlint の幾何（構造辺）を実際にどう受け取るかを決める必要があった。
これは境界設計の判断で、速い道と遅い道があった。

速い道は、Seamlint の `structuralEdges` を **library として直接 import** することだった。手軽で
速い。だがこれは却下した。理由は、それが Seamlint の公開契約（`docs/library-api.md` の
`checkSvgPath` / `checkGeometryRequest` / `inspectSvgExport` / `pointsForPath` /
`projectAstmPassmarkToMarker`）に**無い内部 export**であり、Seamlint の内部幾何モデル
（`edgeId` = ループ index、reduced、dart 畳み）に Truer が結合してしまうからだ。read-only の
狭い契約に、迂回で穴を開けることになる。

採ったのは、遅く見える道——**subprocess + Seamlint 契約の拡張（A1）**。既にある `pointsForPath`
（SVG 版）の、DXF / 構造辺版を Seamlint の表玄関（公開契約）に昇格させる。つまり境界を"迂回"
するのではなく"拡張"する。これは Loomit が Seamlint を subprocess で疎結合に呼ぶやり方とも揃い、
両システムの再利用能力になる。

あわせて、overlay（preview 描画）用の辺幾何を **proposal 自体に載せて self-contained** にした。
preview を proposal の純関数にすることで、将来の Studio が DXF や Seamlint 無しでも再描画できる
（既存の `targetDigest` スナップショットと同じ発想）。このとき schema は、**住所
（`seamReconciliation`）と描画幾何（`preview.edges`）を分離**し、`digest(preview.edges.points)
=== edgeDigest` という不変条件で両者の整合を縛った。edge digest の正本は、Seamlint の canonical
points 直列化に確定した。

まとめると、この判断は「速さのために内部へ結合せず、公開契約を拡張して両システムの境界を保つ」
を選んだ、ということだ。

## 【2026-07-16】apply の書き先を「Truer 所有の補正済み DXF」に決め、curve_kink で A→B を初めて通した

長いあいだ OPEN のままだった「apply が結果をどこに書くか」を、ここで決めた。結論は **Truer 自身が
持つ「補正済み DXF（この 1 着分）」を `--out` に書く**。`.val`（Valentina パラメトリック正本）も Loomit の
master も書かない。

`.val` を書く案は筋が良さそうに見えて、二重に詰まっていた。第一に、`.val` は式と点の構築レシピなので、
安全に書き換えるには Valentina が要る——だがプラグイン API が無い。第二に、もっと本質的に、`.val` を書く道は
この道具の核「preview は嘘をつかない（preview==apply）」と喧嘩する。`.val` に式を書いても "補正後の線" を
描くにはモデルを評価する必要があり、それができるのは Valentina＝Truer 単独では preview に正しい線を出せない。
逆に **DXF 出力は Truer が補正後の polyline を自分で計算して、見せて、そのまま書く**ので preview==apply が
自然に成立する。つまり Valentina を避けるのは妥協ではなく、思想に忠実な選択だった。代償は正直に受け入れた
——補正済み DXF はこの 1 着分で、`.val` master には反映されないので他サイズへ伝播しない（「裁つ前にこの服を
直す」用途への割り切り）。Loomit の master を書かないので握る相手もいない（handshake 不要）。

書き先が決まったことで、ずっと shell だった `apply` を実装し、curve_kink（辺内部の kink）で A→B（propose →
人が accept → apply）を初めて端まで通した。curve_kink を最初の一本に選んだのは、正解が一意——飛び出た 1
頂点を隣り合う 2 点の弦上へ寄せれば kink は消える——で、端点を動かさず（T7）最小・局所（T6）で、憲法に一番
やさしいからだ。長さズレ（seam_length）は「どう詰めるか」の正解が一意でなく、人が操作を選ぶ形が要るので、
同じレールの上の次のスライスに置いた。

実装で守った境界:

- **「Truer は DXF を読むだけ」を、書きへ最小限だけ広げた。** 幾何の読みは従来どおり Seamlint の `slnt edges`
  （A1）。書きは、対象 BLOCK の layer-14 net line の当該頂点の座標だけを差し替え、他は 1 バイトも変えない外科的
  エディタ（`src/adapters/dxf/`）。頂点は index ではなく **現在座標で一意特定**する（Seamlint の edge points は
  dart 畳み済みで raw polyline と index がずれるが、座標は raw に必ず在る）。一致が 0 or 複数なら推測せず fail
  （T6/T8）。全 DXF を再シリアライズしない。
- **preview も apply も単一の `applyChanges` を通す**（T2）。`move-vertex` という DXF 用 change kind を新設し、
  propose/preview/apply を三点同時に対応させた（E2）。
- **accept + digest ゲートは format 非依存**の設計どおり実装。apply は書く前に、辺 points の digest
  （`digestEdgePoints`、正本＝Seamlint canonical points）と全ファイル digest を propose 時と照合し、食い違えば
  1 バイトも書かず fail（T3）。書き込みは atomic（temp→rename、T1）。

残った cross-repo の一手は、Seamlint が curve_kink 診断に辺住所（`actual.edge = {blockName, edgeId, arcRange}`）を
自動で載せること。診断がその住所を運べば propose→apply は通る（実 DXF ＋実 slnt で確認済み）。Seamlint 側で
住所を付ければ、レポートを手書きせずに済む。

## 【2026-07-16】curve_kink の住所は「一意な内部kinkにだけ」— コーナーを踏まない境界に握り直した

curve_kink を A→B で直せるようにしたあと、Seamlint に「curve_kink 診断へ辺の住所を載せてほしい」と依頼した。
その往復で、こちらの前提が間違っていたと分かり、境界の設計をひとつ握り直すことになった。

依頼のとき、curve_kink は「turn 角が 25°〜30° の、辺の内側の頂点」だけに出る——だから属する辺は一意に決まる、
と書いた。だがこれは誤りだった。Seamlint の curve_kink は `> 25°` で**上限なく**発火する。30° は
`structuralEdges` が辺を分割するしきい値で、curve_kink 判定とは別物だった。二つを混同していた。実データを見ると、
curve_kink の大半は 73〜127° の**本物のコーナー**か、120°+ で折り返す**ダート先端**で、こちらが直したい「なだらか
な線に出た不要な内部kink（25〜30°）」はその一部にすぎなかった。

これは怖い発見だった。もし Seamlint がコーナーに「最寄りの単一辺」を機械的に割り当てて住所を出し、Truer が
そこへ「隣接 2 点の弦へ寄せる」補正をかけたら、**本物の型紙コーナーが平らに潰れる**——縫えない型紙を黙って書く、
まさに避けたかった失敗そのものだ。ダート先端も同様（畳んで消えるべき点を辺の内側へ化かす）。curve_kink は
「直すべき欠陥」だけでなく「意図されたコーナー」まで同じ code で拾う、ノイズの多い診断だった。

決着（案A）は、この恐れをそのまま境界の形にした。**Seamlint は、点が一意な単一辺の"内側"に射影できる＝本物の
内部kink のときだけ `actual.edge` を出す。コーナー・ダート先端・射影が曖昧な点には住所を出さない。** Truer 側は
「住所が無い＝直さない（skip）」という既存のフォールバックがそのまま合図になり、コードを一行も足さずに済んだ。
Seamlint は自信の持てない住所を一切出さず、Truer は住所が来たものだけを直す——どちらも「わからないものは
触らない」で揃った。

効いているのは二重の防御だ。Seamlint が入口で分類し（notch 射影の onCorner / ambiguous 機構を流用して、一意な
内部kink だけを住所付きにする）、Truer の側でも endpoint ガード（T7）と頂点マッチの tolerance（T8）が backstop に
なる。片方が漏らしても、もう片方が止める。境界を「賢く広く」ではなく「臆病に狭く」引いたことで、コーナー潰し
という最悪の誤補正を、機構で二重に閉じた。この往復の記録は `seamlint-request-curve-kink-edge.md`（末尾「確定」節）
と Seamlint 側の返信にある。案A の実装は Seamlint 側で、まだ landing していない。

## まだ途中にあるもの

今の Truer は、安全モデルと proposal 契約、addressing の載せ替えまでは固まっているが、まだ
決めきれていない所がある。

- **seam_length の実補正（B）。** 長さズレの「どう詰めるか」は正解が一意でないので、自動では出さず、
  人が操作を選んだものを preview で見せて accept させる形が要る。curve_kink で通したレール（change kind +
  applyChanges + apply）の上に「人が詰め方を選ぶ」を足す次スライス。それまで seam_length は preview-only 固定。
- **Seamlint が curve_kink に辺住所を自動で載せること（cross-repo・shape=案A で合意済み、実装は Seamlint 待ち）。**
  一意な内部kinkにだけ住所、コーナー/ダート先端は住所なし（上の 2026-07-16 章）。今は診断が `actual.edge` を運べば
  propose→apply が通る（確認済み）。Seamlint 側が案A を実装すれば、レポートを手書きせずに済む（S0）。
- **DXF fixture の実ファイル名。** Seamlint の DXF example の具体名が要確認で、docs では placeholder のまま。
  （Truer 側 curve_kink の最小 fixture は `test/fixtures/curve-kink.dxf` を追加した。）

この文書は「完成した正解」の記録ではなく、Truer が一つの恐れ（見たつもりの適用）から invariant
を引き出し、SVG→DXF の pivot でそれを format 非依存に保ったまま載せ替えてきた、その過程の記録で
ある。

## Related Documents

- `../AGENTS.md` — エージェント向け規約の**正本**（常に守る境界 / 行動原則）。
- `README-public-draft.md` / `README.ja-public-draft.md` — 公開 README ドラフト（安全モデルの
  読み物版）。
- `../skills/truer-implementation/references/critical-invariants.md` — invariant の実装ルール。
- `loomit-status-message.md` — Loomit からの source-of-truth 共有（apply 書き先の背景）。
