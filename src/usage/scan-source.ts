import ts from "typescript";
import type { UsageKind, UsageSite } from "./types.js";

/** One package symbol reachable through a name, and the specifier it came from. */
export interface ForwardExport {
  symbol: string;
  specifier: string;
}

/** What a project file re-exports from the package (directly or through other own modules). */
export interface Forward {
  exports: Map<string, ForwardExport>;
  /** Specifiers whose every export is re-exported under its own name. */
  stars: string[];
}

export interface ScanContext {
  /** Resolves a relative specifier to the forward info of a project file, if that file forwards the package. */
  resolve?: (specifier: string) => Forward | undefined;
  /** True when some project file forwards the package (makes computed require/import paths suspicious). */
  hasForwarders?: boolean;
  /** Why a non-package specifier may still load project code that could not be located (path alias, workspace entry). */
  unresolvable?: (specifier: string) => string | undefined;
}

export interface SourceAnalysis {
  sites: UsageSite[];
  forward: Forward | undefined;
  unresolved: string[];
}

type Target = { pkg: string } | { fwd: Forward };
type Val = { ns: Forward } | { one: ForwardExport[] };

interface Binding {
  line: number;
  /** Namespaces fall back to "*" when unused. */
  isNamespace: boolean;
  hasMemberAccess: boolean;
  targets: Target[];
  /** Package symbols this local name stands for (non-namespace bindings). */
  exps: ForwardExport[];
}

/** Sites into `packageName` (or one of its subpaths) found in one source file. */
export function scanSource(file: string, text: string, packageName: string, ctx: ScanContext = {}): UsageSite[] {
  return analyzeSource(file, text, packageName, ctx).sites;
}

export function analyzeSource(file: string, text: string, packageName: string, ctx: ScanContext = {}): SourceAnalysis {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  return new SourceScan(sourceFile, packageName, ctx).run();
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
  /** Identifier nodes that create a tracked binding: not shadows of it. */
  private readonly bindingNames = new Set<ts.Node>();
  private readonly forward: Forward = { exports: new Map(), stars: [] };
  private readonly unresolved: string[] = [];
  private readonly dynamicScope: boolean;

  constructor(
    private readonly source: ts.SourceFile,
    private readonly packageName: string,
    private readonly ctx: ScanContext,
  ) {
    this.dynamicScope = hasDynamicScope(source);
  }

  run(): SourceAnalysis {
    this.collectImports(this.source);
    this.collectMemberAccesses(this.source);
    this.addUnusedNamespaceWildcards();
    this.collectForwards(this.source);
    const forwards = this.forward.exports.size > 0 || this.forward.stars.length > 0;
    return { sites: this.sites, forward: forwards ? this.forward : undefined, unresolved: [...new Set(this.unresolved)] };
  }

  // ---- imports -------------------------------------------------------------

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

  private targetFor(specifier: string): Target | undefined {
    if (this.matches(specifier)) return { pkg: specifier };
    const fwd = this.ctx.resolve?.(specifier);
    if (fwd) return { fwd };
    const why = this.ctx.unresolvable?.(specifier);
    if (why) this.unresolved.push(why);
    return undefined;
  }

  /** Package symbols reached by `name` on a module. */
  private named(target: Target, name: string): ForwardExport[] {
    if ("pkg" in target) return [{ symbol: name, specifier: target.pkg }];
    const hit = target.fwd.exports.get(name);
    if (hit) return [hit];
    return target.fwd.stars.map((specifier) => ({ symbol: name, specifier }));
  }

  /** The whole module used at once. */
  private whole(target: Target): ForwardExport[] {
    if ("pkg" in target) return [{ symbol: "*", specifier: target.pkg }];
    const specs = new Set<string>([...target.fwd.stars, ...[...target.fwd.exports.values()].map((e) => e.specifier)]);
    return [...specs].map((specifier) => ({ symbol: "*", specifier }));
  }

  private add(node: ts.Node, symbol: string, kind: UsageKind, specifier: string): void {
    const line = this.lineOf(node);
    const site: UsageSite = {
      file: this.source.fileName,
      line,
      symbol,
      kind,
      snippet: this.source.text.split("\n")[line - 1]?.trim() ?? "",
    };
    if (specifier !== this.packageName) site.subpath = specifier;
    this.sites.push(site);
  }

  private addAll(node: ts.Node, exps: ForwardExport[], kind: UsageKind): void {
    for (const e of exps) this.add(node, e.symbol, kind, e.specifier);
  }

  private lineOf(node: ts.Node): number {
    return this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
  }

  private bind(local: ts.Identifier, node: ts.Node, isNamespace: boolean, targets: Target[], exps: ForwardExport[]): void {
    this.bindingNames.add(local);
    this.bindings.set(local.text, { line: this.lineOf(node), isNamespace, hasMemberAccess: false, targets, exps });
  }

  private bindNamed(local: ts.Identifier, node: ts.Node, exps: ForwardExport[]): void {
    this.bind(local, node, false, exps.map((e) => ({ pkg: e.specifier })), exps);
  }

  private bindNamespace(local: ts.Identifier, node: ts.Node, target: Target): void {
    this.bind(local, node, true, [target], this.whole(target));
  }

  private onImportDeclaration(node: ts.ImportDeclaration): void {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    const target = this.targetFor(node.moduleSpecifier.text);
    if (!target) return;
    const clause = node.importClause;
    if (!clause) {
      if ("pkg" in target) this.add(node, "*", "import", target.pkg);
      return;
    }

    if (clause.name) {
      const exps = "pkg" in target || target.fwd.exports.has("default") ? this.named(target, "default") : [];
      if (exps.length > 0) {
        this.addAll(clause.name, exps, "import");
        this.bindNamed(clause.name, node, exps);
      } else {
        // A CommonJS forwarder's default import is its whole module.exports.
        this.bindNamespace(clause.name, node, target);
      }
    }
    const namedBindings = clause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) this.bindNamespace(namedBindings.name, node, target);
    else if (namedBindings) {
      for (const element of namedBindings.elements) {
        const exps = this.named(target, (element.propertyName ?? element.name).text);
        this.addAll(element, exps, "import");
        this.bindNamed(element.name, element, exps); // `program.parse()` on a named export is API use too
      }
    }
  }

  private onImportEquals(node: ts.ImportEqualsDeclaration): void {
    const ref = node.moduleReference;
    if (!ts.isExternalModuleReference(ref) || !ts.isStringLiteral(ref.expression)) return;
    const target = this.targetFor(ref.expression.text);
    if (target) this.bindNamespace(node.name, node, target);
  }

  private onReExport(node: ts.ExportDeclaration): void {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const target = this.targetFor(node.moduleSpecifier.text);
    if (!target) return;
    const clause = node.exportClause;
    if (clause && ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        const exps = this.named(target, (element.propertyName ?? element.name).text);
        this.addAll(element, exps, "re-export");
        if (exps[0]) this.forward.exports.set(element.name.text, exps[0]);
      }
    } else if (clause && ts.isNamespaceExport(clause)) {
      const exps = this.whole(target);
      if ("pkg" in target) this.addAll(node, exps, "re-export");
      if (exps[0]) this.forward.exports.set(clause.name.text, exps[0]);
    } else if ("pkg" in target) {
      this.add(node, "*", "re-export", target.pkg);
      this.forward.stars.push(target.pkg);
    } else {
      for (const [name, exp] of target.fwd.exports) if (!this.forward.exports.has(name)) this.forward.exports.set(name, exp);
      this.forward.stars.push(...target.fwd.stars);
    }
  }

  private onCall(call: ts.CallExpression): void {
    const kind = loadKind(call);
    const arg = call.arguments[0];
    if (!kind || !arg) return;
    if (!ts.isStringLiteralLike(arg)) {
      if (this.ctx.hasForwarders && !ts.isStringLiteralLike(arg)) {
        this.unresolved.push(`computed ${kind === "require" ? "require" : "import"} path could load a file that forwards the package`);
      }
      return;
    }
    const target = this.targetFor(arg.text);
    if (!target) return;
    const isPkg = "pkg" in target;

    // `await import(...)` and `(require(...))` wrap the value; look through them.
    let value: ts.Node = call;
    while (ts.isAwaitExpression(value.parent) || ts.isParenthesizedExpression(value.parent)) value = value.parent;
    const parent = value.parent;

    if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
      this.addDestructured(parent.name, kind, target);
    } else if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      this.bindNamespace(parent.name, call, target);
    } else if (ts.isPropertyAccessExpression(parent) && parent.expression === value) {
      if (parent.name.text === "then") this.addThenDestructured(parent, kind, call, target);
      else this.addAll(parent.name, this.named(target, parent.name.text), kind);
    } else if (ts.isElementAccessExpression(parent) && ts.isStringLiteralLike(parent.argumentExpression)) {
      this.addAll(parent, this.named(target, parent.argumentExpression.text), kind);
    } else if (isPkg || !this.isForwardingPosition(parent)) {
      // Forwarding positions (`module.exports = require("./a")`) add no site here; the underlying file already has them.
      this.addAll(call, this.whole(target), kind);
    }
  }

  /** `module.exports = <call>`, `export default <call>`: the value is forwarded, not used. */
  private isForwardingPosition(parent: ts.Node): boolean {
    return (
      (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && isExportsTarget(parent.left)) ||
      ts.isExportAssignment(parent)
    );
  }

  private addDestructured(pattern: ts.ObjectBindingPattern, kind: UsageKind, target: Target): void {
    for (const element of pattern.elements) {
      const key = element.propertyName ?? element.name;
      const exps = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? this.named(target, key.text) : [];
      this.addAll(element, exps, kind);
      if (ts.isIdentifier(element.name)) this.bindNamed(element.name, element, exps);
    }
  }

  /** `import("p").then(({ a }) => ...)` destructures in the callback's parameter. */
  private addThenDestructured(access: ts.PropertyAccessExpression, kind: UsageKind, call: ts.CallExpression, target: Target): void {
    const thenCall = access.parent;
    const callback = ts.isCallExpression(thenCall) ? thenCall.arguments[0] : undefined;
    const param = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback.parameters[0] : undefined;
    if (param && ts.isObjectBindingPattern(param.name)) this.addDestructured(param.name, kind, target);
    else this.addAll(call, this.whole(target), kind);
  }

  // ---- member access and shadowing ----------------------------------------

  private collectMemberAccesses(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      this.onMember(node.expression, node.name, node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      this.onMember(node.expression, node.argumentExpression, node.argumentExpression.text);
    }
    ts.forEachChild(node, (child) => this.collectMemberAccesses(child));
  }

  private onMember(base: ts.Identifier, at: ts.Node, member: string): void {
    const binding = this.bindings.get(base.text);
    if (!binding || this.isShadowed(base)) return;
    binding.hasMemberAccess = true;
    for (const target of binding.targets) this.addAll(at, this.named(target, member), "member-access");
  }

  /** A namespace that's never dereferenced (passed around whole) may use anything. */
  private addUnusedNamespaceWildcards(): void {
    for (const binding of this.bindings.values()) {
      if (!binding.isNamespace || binding.hasMemberAccess) continue;
      for (const target of binding.targets) {
        for (const e of this.whole(target)) {
          const site: UsageSite = {
            file: this.source.fileName,
            line: binding.line,
            symbol: "*",
            kind: "import",
            snippet: this.source.text.split("\n")[binding.line - 1]?.trim() ?? "",
          };
          if (e.specifier !== this.packageName) site.subpath = e.specifier;
          this.sites.push(site);
        }
      }
    }
  }

  /**
   * True when `id` clearly refers to a local declaration (parameter, let/const/var, function, class, catch,
   * loop variable) instead of the tracked import binding. Anything unclear counts as not shadowed, so real
   * package use is never dropped.
   */
  private isShadowed(id: ts.Identifier): boolean {
    if (this.dynamicScope) return false;
    const name = id.text;
    for (let node: ts.Node | undefined = id.parent; node && !ts.isSourceFile(node); node = node.parent) {
      if (ts.isFunctionLike(node)) {
        if (node.parameters.some((p) => this.declaresName(p.name, name))) return true;
        if (ts.isFunctionExpression(node) && node.name?.text === name) return true;
        if ("body" in node && node.body && ts.isBlock(node.body) && this.hoistsVar(node.body, name)) return true;
      }
      if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) {
        const statements = ts.isCaseBlock(node) ? node.clauses.flatMap((c) => [...c.statements]) : node.statements;
        if (statements.some((s) => this.declaresLexically(s, name, id.getStart(this.source)))) return true;
      }
      if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer) {
        const init = node.initializer;
        if (ts.isVariableDeclarationList(init) && init.declarations.some((d) => this.declaresName(d.name, name))) return true;
      }
      if (ts.isCatchClause(node) && node.variableDeclaration && this.declaresName(node.variableDeclaration.name, name)) return true;
    }
    return false;
  }

  private declaresName(pattern: ts.BindingName, name: string): boolean {
    if (ts.isIdentifier(pattern)) return pattern.text === name && !this.bindingNames.has(pattern);
    return pattern.elements.some((el) => !ts.isOmittedExpression(el) && this.declaresName(el.name, name));
  }

  private declaresLexically(statement: ts.Statement, name: string, useStart: number): boolean {
    if (ts.isVariableStatement(statement)) {
      const isVar = (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
      // let/const in the temporal dead zone can't be the referent; var and functions hoist.
      if (!isVar && statement.getStart(this.source) > useStart) return false;
      return statement.declarationList.declarations.some((d) => this.declaresName(d.name, name));
    }
    if (ts.isFunctionDeclaration(statement)) return statement.name?.text === name;
    if (ts.isClassDeclaration(statement)) return statement.name?.text === name && statement.getStart(this.source) <= useStart;
    return false;
  }

  /** `var` declarations hoist to the enclosing function, from any nested block (but not nested functions). */
  private hoistsVar(node: ts.Node, name: string): boolean {
    if (ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      if (node.declarations.some((d) => this.declaresName(d.name, name))) return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && !ts.isFunctionLike(child)) found = this.hoistsVar(child, name);
    });
    return found;
  }

  // ---- forwarding (re-exports through own modules, CommonJS) -----------------

  private collectForwards(node: ts.Node): void {
    if (ts.isExportAssignment(node)) this.onExportAssignment(node);
    else if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) this.setNamed(d.name.text, d.initializer, false);
      }
    } else if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) this.setNamed(el.name.text, el.propertyName ?? el.name);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      this.onAssignment(node);
    }
    ts.forEachChild(node, (child) => this.collectForwards(child));
  }

  private onExportAssignment(node: ts.ExportAssignment): void {
    if (node.isExportEquals) this.replaceAll(node.expression);
    else this.setNamed("default", node.expression);
  }

  private onAssignment(node: ts.BinaryExpression): void {
    const left = node.left;
    if (isModuleExports(left)) return this.replaceAll(node.right);
    const key = exportsMemberName(left);
    if (key !== undefined) this.setNamed(key, node.right);
  }

  /** `module.exports = <expr>` */
  private replaceAll(expr: ts.Expression): void {
    const inner = strip(expr);
    if (ts.isObjectLiteralExpression(inner)) {
      this.forward.exports.clear();
      this.forward.stars.length = 0;
      for (const prop of inner.properties) this.onObjectMember(prop);
      return;
    }
    const val = this.valueOf(inner);
    if (!val) return this.flagIfMentions(inner);
    this.forward.exports.clear();
    this.forward.stars.length = 0;
    if ("ns" in val) {
      for (const [k, v] of val.ns.exports) this.forward.exports.set(k, v);
      this.forward.stars.push(...val.ns.stars);
    } else this.forward.stars.push(...new Set(val.one.map((e) => e.specifier))); // one symbol: over-approximate as the whole module
  }

  private onObjectMember(prop: ts.ObjectLiteralElementLike): void {
    if (ts.isPropertyAssignment(prop)) {
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : undefined;
      if (key === undefined) return this.flagIfMentions(prop.initializer);
      this.setNamed(key, prop.initializer);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      this.setNamed(prop.name.text, prop.name);
    } else if (ts.isSpreadAssignment(prop)) {
      const val = this.valueOf(strip(prop.expression));
      if (!val) return this.flagIfMentions(prop.expression);
      if ("ns" in val) {
        for (const [k, v] of val.ns.exports) this.forward.exports.set(k, v);
        this.forward.stars.push(...val.ns.stars);
      } else this.forward.stars.push(...val.one.map((e) => e.specifier));
    }
    // methods and accessors are package use inside a body, not forwarding; member access already finds them
  }

  private setNamed(exportName: string, expr: ts.Expression, flag = true): void {
    const inner = strip(expr);
    const val = this.valueOf(inner);
    if (!val) return flag ? this.flagIfMentions(inner) : undefined;
    if ("one" in val) {
      if (val.one[0]) this.forward.exports.set(exportName, val.one[0]);
    } else {
      const spec = val.ns.stars[0] ?? [...val.ns.exports.values()][0]?.specifier;
      if (spec !== undefined) this.forward.exports.set(exportName, { symbol: "*", specifier: spec });
    }
  }

  /** The package symbols an expression evaluates to, when that is statically clear. */
  private valueOf(expr: ts.Expression): Val | undefined {
    if (ts.isIdentifier(expr)) {
      const binding = this.bindings.get(expr.text);
      if (!binding || this.isShadowed(expr)) return undefined;
      if (!binding.isNamespace) return { one: binding.exps };
      const ns: Forward = { exports: new Map(), stars: [] };
      for (const t of binding.targets) mergeTarget(ns, t);
      return { ns };
    }
    if (ts.isCallExpression(expr)) {
      const arg = expr.arguments[0];
      if (!loadKind(expr) || !arg || !ts.isStringLiteralLike(arg)) return undefined;
      const target = this.targetFor(arg.text);
      if (!target) return undefined;
      const ns: Forward = { exports: new Map(), stars: [] };
      mergeTarget(ns, target);
      return { ns };
    }
    if (ts.isPropertyAccessExpression(expr) || (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression))) {
      const member = ts.isPropertyAccessExpression(expr) ? expr.name.text : (expr.argumentExpression as ts.StringLiteralLike).text;
      const base = this.valueOf(strip(expr.expression));
      if (!base) return undefined;
      if ("one" in base) return base; // a member of one symbol is still that symbol
      return { one: this.named({ fwd: base.ns }, member) };
    }
    return undefined;
  }

  /** An export assigned from something that touches the package but that we could not follow: caveat, not silence. */
  private flagIfMentions(expr: ts.Node): void {
    if (ts.isFunctionLike(expr) || ts.isClassLike(expr)) return;
    if (this.mentions(expr)) this.unresolved.push("module.exports/export value derived from the package in a form the scanner cannot follow");
  }

  private mentions(node: ts.Node): boolean {
    if (ts.isIdentifier(node) && this.bindings.has(node.text) && !this.bindingNames.has(node)) return true;
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      if (loadKind(node) && arg && ts.isStringLiteralLike(arg) && this.targetFor(arg.text)) return true;
    }
    return ts.forEachChild(node, (child) => (this.mentions(child) ? true : undefined)) ?? false;
  }
}

function mergeTarget(ns: Forward, target: Target): void {
  if ("pkg" in target) ns.stars.push(target.pkg);
  else {
    for (const [k, v] of target.fwd.exports) ns.exports.set(k, v);
    ns.stars.push(...target.fwd.stars);
  }
}

function strip(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  return e;
}

function isModuleExports(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

function isExportsTarget(node: ts.Node): boolean {
  return isModuleExports(node) || exportsMemberName(node) !== undefined;
}

/** `exports.x`, `module.exports.x` (or bracket forms) -> "x". */
function exportsMemberName(node: ts.Node): string | undefined {
  let base: ts.Expression;
  let key: string;
  if (ts.isPropertyAccessExpression(node)) {
    base = node.expression;
    key = node.name.text;
  } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    base = node.expression;
    key = node.argumentExpression.text;
  } else return undefined;
  if (isModuleExports(base) || (ts.isIdentifier(base) && base.text === "exports")) return key;
  return undefined;
}

/** `with` statements and direct `eval` make static scope analysis unreliable. */
function hasDynamicScope(source: ts.SourceFile): boolean {
  let dynamic = false;
  const visit = (node: ts.Node): void => {
    if (dynamic) return;
    if (ts.isWithStatement(node) || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval")) {
      dynamic = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return dynamic;
}

function loadKind(call: ts.CallExpression): UsageKind | undefined {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return "dynamic-import";
  if (ts.isIdentifier(call.expression) && call.expression.text === "require") return "require";
  return undefined;
}
