import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Fence: app code writes `Purchase.fields` only through
 * `updatePurchaseFields` in `purchase-fields-write.ts`. A whole fields object
 * rebuilt from an earlier read deletes every key written in between.
 */
const APP_ROOT = resolve(__dirname, "../..");
const SCANNED_DIRS = ["src", "scripts"];
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|cts)$/;

const ALLOWED = new Set([
  "src/lib/purchase-fields-write.ts",
  // Per-key JSON_SET for the C5 decision and duplicate marker. Under review
  // in a separate change; move it onto the helper once that lands.
  "src/lib/c5-pricing/purchase-decision-sql.ts",
]);

const RAW_PURCHASE_UPDATE =
  /\bUPDATE\s+[`"]?AI_Purchase[`"]?\s[\s\S]*\bfields\b/i;

export function findPurchaseFieldsWrites(fileName: string, text: string) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const tableNames = new Set<string>();
  const violations: string[] = [];
  const at = (node: ts.Node, what: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    violations.push(`${fileName}:${line + 1} ${what}`);
  };

  const collectImports = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (imported === "purchases") tableNames.add(node.name.text);
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(source);

  const isPurchaseTable = (node: ts.Expression | undefined) =>
    !!node &&
    ((ts.isIdentifier(node) && tableNames.has(node.text)) ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "purchases"));

  /** Walks `x.update(t).set(...)` style chains back to the root call. */
  const chainTargets = (expression: ts.Expression, method: string) => {
    let current: ts.Expression = expression;
    while (true) {
      if (ts.isCallExpression(current)) {
        const callee = current.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === method &&
          isPurchaseTable(current.arguments[0])
        )
          return true;
        current = callee;
      } else if (ts.isPropertyAccessExpression(current)) {
        current = current.expression;
      } else if (
        ts.isAwaitExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current)
      ) {
        current = current.expression;
      } else return false;
    }
  };

  /** Reports `fields` in a set object, looking through literal spreads. */
  const checkSetObject = (node: ts.Expression, label: string) => {
    const expression = ts.isParenthesizedExpression(node)
      ? node.expression
      : node;
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (
          (ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)) &&
          property.name.getText(source).replace(/['"]/g, "") === "fields"
        )
          at(property, `${label} sets purchases.fields`);
        else if (ts.isSpreadAssignment(property))
          checkSetObject(property.expression, label);
      }
      return;
    }
    if (ts.isBinaryExpression(expression))
      return checkSetObject(expression.right, label);
    if (ts.isConditionalExpression(expression)) {
      checkSetObject(expression.whenTrue, label);
      checkSetObject(expression.whenFalse, label);
      return;
    }
    if (
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(expression) && expression.text === "undefined")
    )
      return;
    at(expression, `${label} with a set value the fence cannot inspect`);
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const argument = node.arguments[0];
      if (
        method === "set" &&
        argument &&
        chainTargets(node.expression.expression, "update")
      )
        checkSetObject(argument, "update(purchases).set");
      if (
        method === "onDuplicateKeyUpdate" &&
        argument &&
        ts.isObjectLiteralExpression(argument) &&
        chainTargets(node.expression.expression, "insert")
      )
        for (const property of argument.properties)
          if (
            ts.isPropertyAssignment(property) &&
            property.name.getText(source) === "set"
          )
            checkSetObject(property.initializer, "onDuplicateKeyUpdate");
    }
    if (
      (ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isStringLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      RAW_PURCHASE_UPDATE.test(node.getText(source))
    )
      at(node, "raw UPDATE of AI_Purchase fields");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)
      ? [path]
      : [];
  });
}

describe("Purchase.fields write fence", () => {
  it("app code writes Purchase.fields only through updatePurchaseFields", () => {
    const files = SCANNED_DIRS.flatMap((dir) =>
      sourceFiles(join(APP_ROOT, dir)),
    );
    expect(files.length).toBeGreaterThan(100);
    const violations = files.flatMap((path) => {
      const name = relative(APP_ROOT, path);
      if (ALLOWED.has(name)) return [];
      return findPurchaseFieldsWrites(name, readFileSync(path, "utf8"));
    });
    expect(violations).toEqual([]);
  });

  it("catches whole-object writes, aliases, spreads and raw SQL", () => {
    const snippet = `
			import { purchases as purchaseTable } from '@/db/schema'
			import { purchases } from '@/db/schema'
			await db.update(purchases).set({ fields: next }).where(x)
			await tx.update(purchaseTable).set({ status, fields }).where(x)
			await db.update(purchases).set({ ...(ok ? { fields: next } : {}) })
			await db.update(purchases).set(built)
			await db.insert(purchases).values(v).onDuplicateKeyUpdate({ set: { fields: v.fields } })
			await db.execute(sql\`UPDATE AI_Purchase SET fields = \${next}\`)
		`;
    expect(findPurchaseFieldsWrites("planted.ts", snippet)).toEqual([
      "planted.ts:4 update(purchases).set sets purchases.fields",
      "planted.ts:5 update(purchases).set sets purchases.fields",
      "planted.ts:6 update(purchases).set sets purchases.fields",
      "planted.ts:7 update(purchases).set with a set value the fence cannot inspect",
      "planted.ts:8 onDuplicateKeyUpdate sets purchases.fields",
      "planted.ts:9 raw UPDATE of AI_Purchase fields",
    ]);
  });

  it("allows column-only purchase updates and other tables", () => {
    const snippet = `
			import { purchases, users } from '@/db/schema'
			await db.update(purchases).set({ status: 'Refunded', ...(org && { organizationId: org }) })
			await db.update(users).set({ fields: next })
		`;
    expect(findPurchaseFieldsWrites("clean.ts", snippet)).toEqual([]);
  });
});
