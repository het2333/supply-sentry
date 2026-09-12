"use client";

import { useEffect, useRef } from "react";
import { Command } from "cmdk";
import { cn } from "@/lib/utils";

export type CommandMenuItem = { id: string; label: string; keywords?: string[]; disabled?: boolean };

export function CommandMenu({ ariaLabel, inputAriaLabel, items, onSelect, placeholder = "Search…", empty = "No results", className, inputClassName, listClassName, query, onQueryChange, open = true, shouldFilter = true, loading = false, error = null, onInputFocus, onInputKeyDown, renderItem }: {
  ariaLabel: string;
  inputAriaLabel?: string;
  items: CommandMenuItem[];
  onSelect: (id: string) => void;
  placeholder?: string;
  empty?: React.ReactNode;
  className?: string;
  inputClassName?: string;
  listClassName?: string;
  query?: string;
  onQueryChange?: (value: string) => void;
  open?: boolean;
  shouldFilter?: boolean;
  loading?: boolean;
  error?: React.ReactNode;
  onInputFocus?: React.FocusEventHandler<HTMLInputElement>;
  onInputKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  renderItem?: (item: CommandMenuItem) => React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.setAttribute("aria-expanded", String(open)); }, [open]);
  return <Command aria-label={ariaLabel} shouldFilter={shouldFilter} className={cn("overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl", className)}>
    <Command.Input ref={inputRef} value={query} onValueChange={onQueryChange} onFocus={onInputFocus} onKeyDown={onInputKeyDown} aria-label={inputAriaLabel ?? `${ariaLabel} search`} aria-expanded={open} placeholder={placeholder} className={cn("h-11 w-full border-b border-slate-200 px-4 text-sm outline-none", inputClassName)} />
    {open ? <Command.List className={cn("max-h-72 overflow-y-auto p-1.5", listClassName)}>
      {error ? <div role="alert" className="px-4 py-8 text-center text-xs text-red-600">{error}</div> : loading ? <div role="status" className="px-4 py-8 text-center text-xs text-slate-500">Loading…</div> : <>
        <Command.Empty className="px-4 py-8 text-center text-xs text-slate-500">{empty}</Command.Empty>
        {items.map((item) => <Command.Item key={item.id} value={`${item.label} ${item.keywords?.join(" ") ?? ""}`} disabled={item.disabled} onSelect={() => onSelect(item.id)} className="cursor-default rounded-lg px-3 py-2 text-sm outline-none data-[disabled=true]:opacity-40 data-[selected=true]:bg-slate-100">{renderItem ? renderItem(item) : item.label}</Command.Item>)}
      </>}
    </Command.List> : null}
  </Command>;
}
