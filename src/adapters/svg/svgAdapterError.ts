// Errors the SVG adapter raises when a target path cannot be resolved to exactly
// one element. Codes are stable and match references/testing-proposals.md "Codes".
// We never guess which path was meant (references/critical-invariants.md T6).

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
