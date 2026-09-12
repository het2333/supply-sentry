"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { format, isValid, parseISO, startOfDay, startOfQuarter, startOfYear, subDays } from "date-fns";
import { DayPicker, type DateRange } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import { CalendarDays, ChevronDown, Eye, Mail, MoreHorizontal, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export type RouteFilterOption = { id: string; label: string };
export type RouteOrderActionCapabilities = {
  followup: boolean;
  updateRihd: boolean;
  markAtRisk: boolean;
};

function useOverlayPosition(open: boolean, triggerRef: RefObject<HTMLElement | null>, width: number, align: "start" | "end") {
  const [position, setPosition] = useState({ left: 16, top: 16, width });
  const update = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const actualWidth = Math.min(width, Math.max(240, viewportWidth - 32));
    const preferredLeft = align === "end" ? rect.right - actualWidth : rect.left;
    setPosition({
      left: Math.max(16, Math.min(preferredLeft, viewportWidth - actualWidth - 16)),
      top: rect.bottom + 8,
      width: actualWidth,
    });
  }, [align, triggerRef, width]);
  useEffect(() => {
    if (!open) return;
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, update]);
  return position;
}

function useDismissOverlay(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  overlayRef: RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || triggerRef.current?.contains(target) || overlayRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open, overlayRef, triggerRef]);
}

function useEscapeOverlay(open: boolean, closeAndRestoreFocus: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeAndRestoreFocus, open]);
}

function menuKeyDown(event: ReactKeyboardEvent<HTMLElement>, closeAndRestoreFocus: () => void) {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeAndRestoreFocus();
    return;
  }
  if (!items.length || !["Home", "End", "ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  const activeIndex = items.indexOf(document.activeElement as HTMLElement);
  const nextIndex = event.key === "Home" ? 0
    : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (activeIndex + 1 + items.length) % items.length
        : (activeIndex - 1 + items.length) % items.length;
  items[nextIndex]?.focus();
}

export function RouteFilterMenu({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: RouteFilterOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const openFocusRef = useRef<"menu" | "first" | "last">("menu");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.id === value);
  const position = useOverlayPosition(open, triggerRef, 160, "start");
  const close = useCallback(() => setOpen(false), []);
  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  useDismissOverlay(open, triggerRef, menuRef, close);
  useEscapeOverlay(open, closeAndRestoreFocus);
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (openFocusRef.current === "menu") {
      menu?.focus();
      return;
    }
    const items = menu?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const item = openFocusRef.current === "last" ? items?.item((items?.length ?? 1) - 1) : items?.item(0);
    item?.focus();
  }, [open]);

  const openFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    openFocusRef.current = event.key === "ArrowUp" ? "last" : "first";
    setOpen(true);
  };

  return <>
    <button
      ref={triggerRef}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      onPointerDown={() => { openFocusRef.current = "menu"; }}
      onKeyDown={openFromKeyboard}
      onClick={() => setOpen((current) => !current)}
      className={cn(
        "flex h-9 max-w-[190px] shrink-0 items-center gap-1.5 rounded-full border bg-white px-3 text-[10px] font-semibold transition",
        selected ? "border-blue-300 text-blue-700" : "border-[#dfe3eb] text-[#5d6879] hover:border-blue-200 hover:text-blue-700",
      )}
    >
      <span data-preserve-language={selected ? true : undefined} className="truncate">{selected?.label ?? label}</span><ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
    </button>
    {open && typeof document !== "undefined" && createPortal(
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(event) => menuKeyDown(event, closeAndRestoreFocus)}
        style={{ position: "fixed", left: position.left, top: position.top, width: position.width }}
        className="z-[95] rounded-xl border border-slate-200 bg-white p-1.5 text-xs shadow-xl outline-none"
      >
        {options.map((option) => <button
          key={option.id}
          type="button"
          role="menuitem"
          data-preserve-language
          tabIndex={-1}
          onClick={() => {
            onChange(value === option.id ? "all" : option.id);
            closeAndRestoreFocus();
          }}
          className={cn("flex w-full items-center rounded-lg px-3 py-2 text-left text-[11px] font-medium text-[#48566b] outline-none hover:bg-slate-100 focus:bg-slate-100", value === option.id && "bg-blue-50 text-blue-700")}
        >{option.label}</button>)}
      </div>,
      document.body,
    )}
  </>;
}

function parsedDate(value: string): Date | undefined {
  if (!value) return undefined;
  const date = parseISO(value);
  return isValid(date) ? date : undefined;
}

function formattedRange(range: DateRange | undefined): string {
  if (!range?.from || !range.to) return "请选择日期";
  return `${format(range.from, "yyyy 年 M 月 d 日", { locale: zhCN })} – ${format(range.to, "yyyy 年 M 月 d 日", { locale: zhCN })}`;
}

function sameDay(left: Date | undefined, right: Date | undefined): boolean {
  return Boolean(left && right && format(left, "yyyy-MM-dd") === format(right, "yyyy-MM-dd"));
}

export function RouteDateRangeFilter({ from, to, onApply }: {
  from: string;
  to: string;
  onApply: (value: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const todayRef = useRef<HTMLButtonElement | null>(null);
  const today = startOfDay(new Date());
  const triggerLabel = from && to ? `${format(parseISO(from), "yyyy 年 M 月 d 日", { locale: zhCN })} – ${format(parseISO(to), "yyyy 年 M 月 d 日", { locale: zhCN })}` : "日期范围";
  const quickRanges = [
    { label: "今天", range: { from: today, to: today } },
    { label: "最近 7 天", range: { from: subDays(today, 6), to: today } },
    { label: "最近 30 天", range: { from: subDays(today, 29), to: today } },
    { label: "本季度", range: { from: startOfQuarter(today), to: today } },
    { label: "年初至今", range: { from: startOfYear(today), to: today } },
  ];
  const position = useOverlayPosition(open, triggerRef, 548, "end");
  const close = useCallback(() => setOpen(false), []);
  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  useDismissOverlay(open, triggerRef, dialogRef, close);
  useEscapeOverlay(open, closeAndRestoreFocus);
  useEffect(() => { if (open) todayRef.current?.focus(); }, [open]);
  const toggle = () => {
    if (open) { closeAndRestoreFocus(); return; }
    const nextFrom = parsedDate(from);
    const nextTo = parsedDate(to);
    setDraft(nextFrom || nextTo ? { from: nextFrom, to: nextTo } : undefined);
    setOpen(true);
  };

  return <>
    <button
      ref={triggerRef}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={toggle}
      className={cn(
        "flex h-9 max-w-[230px] shrink-0 items-center gap-1.5 rounded-full border bg-white px-3 text-[10px] font-semibold transition",
        open || from || to ? "border-blue-300 text-blue-700" : "border-[#dfe3eb] text-[#5d6879] hover:border-blue-200 hover:text-blue-700",
      )}
    >
      <CalendarDays className="size-3.5 shrink-0" /><span className="truncate">{triggerLabel}</span><ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
    </button>
    {open && typeof document !== "undefined" && createPortal(
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="日期范围"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          closeAndRestoreFocus();
        }}
        style={{ position: "fixed", left: position.left, top: position.top, width: position.width }}
        className="z-[95] max-h-[calc(100vh-32px)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-xl outline-none"
      >
        <div className="grid gap-4 sm:grid-cols-[132px_minmax(280px,1fr)]">
          <div>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8b94a3]">快捷范围</div>
            <div className="space-y-1">{quickRanges.map((quick, index) => {
              const active = sameDay(draft?.from, quick.range.from) && sameDay(draft?.to, quick.range.to);
              return <button
                ref={index === 0 ? todayRef : undefined}
                key={quick.label}
                type="button"
                onClick={() => setDraft(quick.range)}
                className={cn("block h-8 w-full rounded-lg px-2.5 text-left text-[10px] font-medium outline-none", active ? "bg-blue-50 text-blue-700" : "text-[#596579] hover:bg-[#f5f7fa] focus:bg-[#f5f7fa]")}
              >{quick.label}</button>;
            })}</div>
          </div>
          <div>
            <DayPicker mode="range" locale={zhCN} defaultMonth={draft?.from ?? today} selected={draft} onSelect={setDraft} />
            <div className="mt-1 text-center text-[10px] font-medium text-[#657083]">{formattedRange(draft)}</div>
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2 border-t border-[#edf0f4] pt-3">
          <button type="button" onClick={closeAndRestoreFocus} className="h-9 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#657083]">取消</button>
          <button type="button" disabled={!draft?.from || !draft.to} onClick={() => {
            if (!draft?.from || !draft.to) return;
            onApply({ from: format(draft.from, "yyyy-MM-dd"), to: format(draft.to, "yyyy-MM-dd") });
            closeAndRestoreFocus();
          }} className="h-9 rounded-xl bg-[#2563eb] px-4 text-xs font-semibold text-white disabled:opacity-40">应用</button>
        </div>
      </div>,
      document.body,
    )}
  </>;
}

export function RouteOrderActionsMenu({ number, capabilities, onViewDetails, onFollowUp, onEditRihd, onMarkAtRisk }: {
  number: string;
  capabilities: RouteOrderActionCapabilities;
  onViewDetails: () => void;
  onFollowUp: (returnFocusElement: HTMLButtonElement | null) => void;
  onEditRihd: (returnFocusElement: HTMLButtonElement | null) => void;
  onMarkAtRisk: (returnFocusElement: HTMLButtonElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const openFocusRef = useRef<"menu" | "first" | "last">("menu");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const position = useOverlayPosition(open, triggerRef, 196, "end");
  const close = useCallback(() => setOpen(false), []);
  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  useDismissOverlay(open, triggerRef, menuRef, close);
  useEscapeOverlay(open, closeAndRestoreFocus);
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (openFocusRef.current === "menu") {
      menu?.focus();
      return;
    }
    const items = menu?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const item = openFocusRef.current === "last" ? items?.item((items?.length ?? 1) - 1) : items?.item(0);
    item?.focus();
  }, [open]);
  const openFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    openFocusRef.current = event.key === "ArrowUp" ? "last" : "first";
    setOpen(true);
  };
  const choose = (action: (returnFocusElement: HTMLButtonElement | null) => void) => {
    setOpen(false);
    action(triggerRef.current);
  };

  return <>
    <button ref={triggerRef} type="button" aria-label={`${number} 操作`} aria-haspopup="menu" aria-expanded={open} onPointerDown={() => { openFocusRef.current = "menu"; }} onKeyDown={openFromKeyboard} onClick={() => setOpen((current) => !current)} className="flex size-8 items-center justify-center rounded-lg text-[#8993a3] opacity-0 transition hover:bg-[#edf2f9] hover:text-[#26364f] focus-visible:opacity-100 group-hover:opacity-100"><MoreHorizontal className="size-4" /></button>
    {open && typeof document !== "undefined" && createPortal(
      <div
        ref={menuRef}
        role="menu"
        aria-label={`${number} 操作`}
        tabIndex={-1}
        onKeyDown={(event) => menuKeyDown(event, closeAndRestoreFocus)}
        style={{ position: "fixed", left: position.left, top: position.top, width: position.width }}
        className="z-[95] rounded-xl border border-slate-200 bg-white p-1.5 text-xs shadow-xl outline-none"
      >
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); onViewDetails(); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] font-medium text-[#48566b] outline-none hover:bg-slate-100 focus:bg-slate-100"><Eye className="size-3.5 text-[#2563eb]" />查看详情</button>
        {capabilities.followup && <button type="button" role="menuitem" tabIndex={-1} onClick={() => choose(onFollowUp)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] font-medium text-[#48566b] outline-none hover:bg-slate-100 focus:bg-slate-100"><Mail className="size-3.5 text-[#2563eb]" />发送跟进</button>}
        {capabilities.updateRihd && <button type="button" role="menuitem" tabIndex={-1} onClick={() => choose(onEditRihd)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] font-medium text-[#48566b] outline-none hover:bg-slate-100 focus:bg-slate-100"><CalendarDays className="size-3.5 text-[#2563eb]" />修改 RIHD</button>}
        {capabilities.markAtRisk && <><div role="separator" className="my-1 h-px bg-[#edf0f4]" /><button type="button" role="menuitem" tabIndex={-1} onClick={() => choose(onMarkAtRisk)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] font-medium text-red-600 outline-none hover:bg-red-50 focus:bg-red-50"><ShieldAlert className="size-3.5" />标记风险</button></>}
      </div>,
      document.body,
    )}
  </>;
}
