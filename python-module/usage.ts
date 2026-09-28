/**
 * Phase 4 of #15: static usage scan via Python's own `ast` module. The driver below is
 * inline (passed with `-c`, source read from stdin as JSON) rather than a checked-in .py
 * file, so there is no separate asset to resolve a path to at runtime — the compiled JS
 * works the same whether it runs from python-module/, dist-test/, or a future dist/.
 * No JS-side Python parser dependency, per the phase-1 scope lock (python-module/README.md).
 */
import { spawn } from "node:child_process";

export type PythonUsageKind = "import" | "from-import";

export interface PythonUsageSite {
  file: string;
  line: number;
  /** Bound name at the site: the alias for `import x as y`, the imported name for `from x import y`. */
  symbol: string;
  kind: PythonUsageKind;
  /** Full dotted module named in the import statement. */
  module: string;
  snippet: string;
}

export interface PythonUnparsedFile {
  file: string;
}

export interface PythonUsageScan {
  sites: PythonUsageSite[];
  /** Files with syntax errors: the scan is incomplete, so a verdict must not claim full coverage. */
  unparsed: PythonUnparsedFile[];
}

export interface PythonSourceFile {
  /** Project-relative, forward slashes. */
  path: string;
  text: string;
}

export interface ScanPythonUsageOptions {
  /** Interpreter to invoke (default "python3"). */
  pythonPath?: string;
}

const DRIVER = `
import ast, json, sys

def main():
    data = json.load(sys.stdin)
    package = data["package"]
    sites = []
    unparsed = []
    for f in data["files"]:
        path = f["path"]
        text = f["text"]
        try:
            tree = ast.parse(text, filename=path)
        except SyntaxError:
            unparsed.append({"file": path})
            continue
        lines = text.splitlines()

        def snippet(lineno):
            return lines[lineno - 1].strip() if 0 <= lineno - 1 < len(lines) else ""

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    top = alias.name.split(".")[0]
                    if top != package:
                        continue
                    sites.append({
                        "file": path, "line": node.lineno,
                        "symbol": alias.asname or alias.name,
                        "kind": "import", "module": alias.name,
                        "snippet": snippet(node.lineno),
                    })
            elif isinstance(node, ast.ImportFrom):
                if node.level and node.level > 0:
                    continue  # relative import: cannot name a third-party package
                mod = node.module or ""
                if mod.split(".")[0] != package:
                    continue
                for alias in node.names:
                    sites.append({
                        "file": path, "line": node.lineno,
                        "symbol": alias.asname or alias.name,
                        "kind": "from-import", "module": mod,
                        "snippet": snippet(node.lineno),
                    })
    json.dump({"sites": sites, "unparsed": unparsed}, sys.stdout)

main()
`;

export async function scanPythonUsage(
  packageName: string,
  files: PythonSourceFile[],
  options: ScanPythonUsageOptions = {},
): Promise<PythonUsageScan> {
  const python = options.pythonPath ?? "python3";
  const input = JSON.stringify({ package: packageName, files });
  const { stdout, stderr, exitCode } = await runPython(python, input);
  if (exitCode !== 0) throw new Error(`python ast scan failed (exit ${exitCode}): ${stderr.trim() || "no output"}`);
  return JSON.parse(stdout) as PythonUsageScan;
}

function runPython(python: string, input: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", DRIVER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    child.stdin.end(input);
  });
}
