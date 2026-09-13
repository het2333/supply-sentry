// Read-only inventory of interface copy; never reads runtime data or credentials.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const roots = ["apps/console/app", "apps/console/features", "apps/console/components"];
const files = execFileSync("rg", ["--files", ...roots], { encoding: "utf8" }).trim().split("\n")
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes("/localization/"));
const messages = new Map();
const normalize = (value) => value.trim().replace(/\s+/g, " ");
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    let value;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) value = node.text;
    if (ts.isTemplateExpression(node)) value = node.head.text + node.templateSpans.map((span, index) => `{${index}}${span.literal.text}`).join("");
    if (value && /[\u3400-\u9fff]/u.test(value)) {
      const key = normalize(value);
      if (!messages.has(key)) messages.set(key, new Set());
      messages.get(key).add(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const group = (paths) => {
  if (paths.some((file) => /app\//.test(file) || /editor\//.test(file) || /platform\//.test(file))) return "platform";
  if (paths.some((file) => /po-employee|requisitions|rfqs|ap-workbench|operations|\/workbench\.|domain-sections|po-intake|po-detail|po-document|po-work/.test(file))) return "orders";
  return "settings";
};
const all = [...messages].map(([key, paths]) => ({ key, files: [...paths], group: group([...paths]) }));
const requested = process.argv[2];
console.log(JSON.stringify(requested ? all.filter((entry) => entry.group === requested) : all, null, 2));
