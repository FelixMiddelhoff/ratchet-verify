import ts from "typescript";
import type { UsageKind, UsageSite } from "./types.js";

interface Binding {
  line: number;
  /** Default imports already produced a "default" site; namespaces fall back to "*" when unused. */
  isNamespace: boolean;
  hasMemberAccess: boolean;
  specifier: string;
}

/** Sites into `packageName` (or one of its subpaths) found in one source file. */
export function scanSource(file: string, text: string, packageName: string): UsageSite[] {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  return new SourceScan(sourceFile, packageName).run();
}

/** True when the file has syntax errors, so its usage list can't be trusted to be complete. */
export function hasSyntaxErrors(file: string, text: string): boolean {
  const { diagnostics } = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve },
  });
  return (diagnostics ?? []).length > 0;
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (/\.(tsx)$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.(ts|mts|cts)$/.test(file)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

class SourceScan {
  private readonly sites: UsageSite[] = [];
  private readonly bindings = new Map<string, Binding>();
  private currentSpecifier = "";

  constructor(
    private readonly source: ts.SourceFile,
    private readonly packageName: string,
  ) {}

  run(): UsageSite[] {
    this.collectImports(this.source);
    this.collectMemberAccesses(this.source);
    this.addUnusedNamespaceWildcards();
    return this.sites;
  }

  private collectImports(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) this.onImportDeclaration(node);
    else if (ts.isImportEqualsDeclaration(node)) this.onImportEquals(node);
    else if (ts.isExportDeclaration(node)) this.onReExport(node);
    else if (ts.isCallExpression(node)) this.onCall(node);
    ts.forEachChild(node, (child) => this.collectImports(child));
  }

  private matches(specifier: string): boolean {
    return specifier === this.packageName || specifier.startsWith(`${this.packageName}/`);
  }

  private add(node: ts.Node, symbol: string, kind: UsageKind): void {
    const line = this.lineOf(node);
    const site: UsageSite = {
      file: this.source.fileName,
      line,
      symbol,
      kind,
      snippet: this.source.text.split("\n")[line - 1]?.trim() ?? "",
    };
    if (this.currentSpecifier !== this.packageName) site.subpath = this.currentSpecifier;
    this.sites.push(site);
  }

  private lineOf(node: ts.Node): number {
    return this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
  }

  private bind(local: ts.Identifier, node: ts.Node, isNamespace: boolean): void {
    this.bindings.set(local.text, { line: this.lineOf(node), isNamespace, hasMemberAccess: false, specifier: this.currentSpecifier });
  }

  private onImportDeclaration(node: ts.ImportDeclaration): void {
    if (!ts.isStringLiteral(node.moduleSpecifier) || !this.matches(node.moduleSpecifier.text)) return;
    this.currentSpecifier = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (!clause) return this.add(node, "*", "import");

    if (clause.name) {
      this.add(clause.name, "default", "import");
      this.bind(clause.name, node, false);
    }
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) this.bind(named.name, node, true);
    else if (named) {
      for (const element of named.elements) {
        this.add(element, (element.propertyName ?? element.name).text, "import");
        this.bind(element.name, element, false); // `program.parse()` on a named export is API use too
      }
    }
  }

  private onImportEquals(node: ts.ImportEqualsDeclaration): void {
    const ref = node.moduleReference;
    if (!ts.isExternalModuleReference(ref) || !ts.isStringLiteral(ref.expression)) return;
    if (!this.matches(ref.expression.text)) return;
    this.currentSpecifier = ref.expression.text;
    this.bind(node.name, node, true);
  }

  private onReExport(node: ts.ExportDeclaration): void {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier) || !this.matches(node.moduleSpecifier.text)) return;
    this.currentSpecifier = node.moduleSpecifier.text;
    const clause = node.exportClause;
    if (clause && ts.isNamedExports(clause)) {
      for (const element of clause.elements) this.add(element, (element.propertyName ?? element.name).text, "re-export");
    } else {
      this.add(node, "*", "re-export");
    }
  }

  private onCall(call: ts.CallExpression): void {
    const kind = loadKind(call);
    const arg = call.arguments[0];
    if (!kind || !arg || !ts.isStringLiteralLike(arg) || !this.matches(arg.text)) return;
    this.currentSpecifier = arg.text;

    // `await import(...)` and `(require(...))` wrap the value; look through them.
    let value: ts.Node = call;
    while (ts.isAwaitExpression(value.parent) || ts.isParenthesizedExpression(value.parent)) value = value.parent;
    const parent = value.parent;

    if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
      this.addDestructured(parent.name, kind);
    } else if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      this.bind(parent.name, call, true);
    } else if (ts.isPropertyAccessExpression(parent) && parent.expression === value) {
      if (parent.name.text === "then") this.addThenDestructured(parent, kind, call);
      else this.add(parent.name, parent.name.text, kind);
    } else if (ts.isElementAccessExpression(parent) && ts.isStringLiteralLike(parent.argumentExpression)) {
      this.add(parent, parent.argumentExpression.text, kind);
    } else {
      this.add(call, "*", kind);
    }
  }

  private addDestructured(pattern: ts.ObjectBindingPattern, kind: UsageKind): void {
    for (const element of pattern.elements) {
      const key = element.propertyName ?? element.name;
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) this.add(element, key.text, kind);
      if (ts.isIdentifier(element.name)) this.bind(element.name, element, false);
    }
  }

  /** `import("p").then(({ a }) => ...)` destructures in the callback's parameter. */
  private addThenDestructured(access: ts.PropertyAccessExpression, kind: UsageKind, call: ts.CallExpression): void {
    const thenCall = access.parent;
    const callback = ts.isCallExpression(thenCall) ? thenCall.arguments[0] : undefined;
    const param = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback.parameters[0] : undefined;
    if (param && ts.isObjectBindingPattern(param.name)) this.addDestructured(param.name, kind);
    else this.add(call, "*", kind);
  }

  private collectMemberAccesses(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      this.onMember(node.expression.text, node.name, node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      this.onMember(node.expression.text, node.argumentExpression, node.argumentExpression.text);
    }
    ts.forEachChild(node, (child) => this.collectMemberAccesses(child));
  }

  private onMember(base: string, at: ts.Node, member: string): void {
    const binding = this.bindings.get(base);
    if (!binding) return;
    binding.hasMemberAccess = true;
    this.currentSpecifier = binding.specifier;
    this.add(at, member, "member-access");
  }

  /** A namespace that's never dereferenced (passed around whole) may use anything. */
  private addUnusedNamespaceWildcards(): void {
    for (const binding of this.bindings.values()) {
      if (!binding.isNamespace || binding.hasMemberAccess) continue;
      const site: UsageSite = {
        file: this.source.fileName,
        line: binding.line,
        symbol: "*",
        kind: "import",
        snippet: this.source.text.split("\n")[binding.line - 1]?.trim() ?? "",
      };
      if (binding.specifier !== this.packageName) site.subpath = binding.specifier;
      this.sites.push(site);
    }
  }
}

function loadKind(call: ts.CallExpression): UsageKind | undefined {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return "dynamic-import";
  if (ts.isIdentifier(call.expression) && call.expression.text === "require") return "require";
  return undefined;
}
