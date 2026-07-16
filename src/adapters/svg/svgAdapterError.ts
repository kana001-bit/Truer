// target path をちょうど 1 element に解決できないとき SVG adapter が投げる error。code は安定で、
// references/testing-proposals.md の "Codes" と一致する。どの path が意図されたかは決して推測しない
//（references/critical-invariants.md T6）。

export const SVG_PATH_NOT_FOUND = "proposal.path_not_found";
export const SVG_DUPLICATE_PATH_ID = "proposal.duplicate_path_id";

export class SvgAdapterError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SvgAdapterError";
    this.code = code;
  }
}
