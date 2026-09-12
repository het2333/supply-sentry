"use client";

import { useRef } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

export function DataTable<T>({ ariaLabel, columns, rows, loading = false, error = null, empty = "No records", className, tableClassName, virtualize = false }: {
  ariaLabel: string;
  columns: ColumnDef<T, unknown>[];
  rows: T[];
  loading?: boolean;
  error?: string | null;
  empty?: React.ReactNode;
  className?: string;
  tableClassName?: string;
  virtualize?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // TanStack Table intentionally returns callable table state; consumers keep it inside this non-memoized boundary.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  const modelRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({ count: modelRows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 48, overscan: 8, enabled: virtualize });
  const virtualRows = virtualize ? virtualizer.getVirtualItems() : modelRows.map((_, index) => ({ index, start: index * 48, size: 48, end: (index + 1) * 48, key: index, lane: 0 }));
  const top = virtualize ? virtualRows[0]?.start ?? 0 : 0;
  const bottom = virtualize ? Math.max(0, virtualizer.getTotalSize() - (virtualRows.at(-1)?.end ?? 0)) : 0;
  return <div ref={scrollRef} className={cn("max-w-full overflow-auto rounded-2xl border border-slate-200 bg-white", className)}>
    <table aria-label={ariaLabel} aria-rowcount={modelRows.length} className={cn("w-full text-left text-xs", tableClassName)}>
      <thead className="sticky top-0 z-10 bg-slate-50"><tr>{table.getFlatHeaders().map((header) => <th key={header.id} className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-500">{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr></thead>
      <tbody>
        {loading ? <tr><td colSpan={columns.length} role="status" className="px-4 py-12 text-center text-slate-500">Loading…</td></tr> : error ? <tr><td colSpan={columns.length} role="alert" className="px-4 py-12 text-center text-red-600">{error}</td></tr> : modelRows.length === 0 ? <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-slate-500">{empty}</td></tr> : <>{top > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: top }} /></tr>}{virtualRows.map((virtualRow) => { const row = modelRows[virtualRow.index]!; return <tr key={row.id} className="border-b border-slate-100 last:border-0">{row.getVisibleCells().map((cell) => <td key={cell.id} className="px-4 py-3">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>; })}{bottom > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: bottom }} /></tr>}</>}
      </tbody>
    </table>
  </div>;
}
