import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const packageJson = JSON.parse(read("../package.json")) as { dependencies: Record<string, string> };

test("approved UI dependencies are pinned exactly and forbidden libraries remain absent", () => {
  const expected = {
    "@tanstack/react-table": "8.21.3",
    "@tanstack/react-virtual": "3.14.10",
    "@radix-ui/react-dialog": "1.1.23",
    "@radix-ui/react-dropdown-menu": "2.1.24",
    "@radix-ui/react-popover": "1.1.23",
    "@radix-ui/react-tooltip": "1.2.16",
    recharts: "3.10.1",
    "react-day-picker": "10.0.1",
    "date-fns": "4.4.0",
    cmdk: "1.1.1",
    dompurify: "3.4.14",
  };
  for (const [name, version] of Object.entries(expected)) assert.equal(packageJson.dependencies[name], version, name);
  for (const name of ["maplibre-gl", "@tiptap-pro/extension", "ag-grid-enterprise", "react-pdf"]) assert.equal(packageJson.dependencies[name], undefined, name);
});

test("UI wrappers expose view-only contracts and accessibility primitives", () => {
  const dialog = read("../components/ui/dialog.tsx");
  const menu = read("../components/ui/dropdown-menu.tsx");
  const popover = read("../components/ui/popover.tsx");
  const tooltip = read("../components/ui/tooltip.tsx");
  const table = read("../components/ui/data-table.tsx");
  const range = read("../components/ui/date-range.tsx");
  const command = read("../components/ui/command-menu.tsx");
  for (const source of [dialog, menu, popover, tooltip, table, range, command]) {
    assert.doesNotMatch(source, /apiRequest|fetch\(|localStorage|success(?:State)?\??:/i);
  }
  assert.match(dialog, /DialogPrimitive\.Content/);
  assert.match(dialog, /DialogPrimitive\.Close aria-label/);
  assert.match(menu, /DropdownPrimitive\.Item/);
  assert.match(popover, /PopoverPrimitive\.Content/);
  assert.match(tooltip, /TooltipPrimitive\.Content/);
  assert.match(table, /role="status"/);
  assert.match(table, /role="alert"/);
  assert.match(table, /modelRows\.length === 0/);
  assert.match(range, /mode="range"/);
  assert.match(command, /Command\.Empty/);
});

test("Risk route lazy-loads Recharts and does not statically pull it into the page module", () => {
  const risk = read("../features/procurement/risk-dashboard.tsx");
  const chart = read("../features/procurement/risk-recharts.tsx");
  assert.match(risk, /dynamic\(\(\) => import\("@\/features\/procurement\/risk-recharts"\)/);
  assert.doesNotMatch(risk, /from "recharts"/);
  assert.match(chart, /from "recharts"/);
});

test("approved wrappers are consumed by real procurement pages", () => {
  const risk = read("../features/procurement/risk-dashboard.tsx");
  const suppliers = read("../features/procurement/suppliers-workbench.tsx");
  const header = read("../features/procurement/global-header.tsx");
  assert.match(risk, /<DataTable/);
  assert.match(risk, /<DateRangePicker/);
  assert.match(risk, /<Popover/);
  assert.match(risk, /<TooltipProvider/);
  assert.match(suppliers, /<DropdownMenu/);
  assert.match(suppliers, /<Dialog/);
  assert.match(header, /<CommandMenu/);
});
