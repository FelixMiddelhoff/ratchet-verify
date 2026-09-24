export type UsageKind = "import" | "require" | "dynamic-import" | "re-export" | "member-access";

export interface UsageSite {
  /** Project-relative, forward slashes. */
  file: string;
  line: number;
  /** Exported name used at this site; "default" for a default import, "*" when the whole module is used. */
  symbol: string;
  kind: UsageKind;
  /** Set when the site imports a subpath such as "pkg/sub". */
  subpath?: string;
  snippet: string;
}

export interface UnparsedFile {
  file: string;
}

/** A file whose forwarding of the package could not be followed statically. */
export interface UnresolvedFile {
  file: string;
  reason: string;
}

export interface UsageScan {
  sites: UsageSite[];
  /** Files with syntax errors: the scan is incomplete, so a verdict must not claim full coverage. */
  unparsed: UnparsedFile[];
  /** Files that forward the package in a way the scanner could not follow: also incomplete coverage. */
  unresolved?: UnresolvedFile[];
}
