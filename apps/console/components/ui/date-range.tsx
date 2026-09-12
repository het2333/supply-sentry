"use client";

import { useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import { DayPicker, type DateRange } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";

export type DateRangeValue = { from: string; to: string };

export function DateRangePicker({ ariaLabel, value, onChange, disabled = false }: { ariaLabel: string; value: DateRangeValue; onChange: (value: DateRangeValue) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<DateRange | undefined>({ from: parseISO(value.from), to: parseISO(value.to) });
  useEffect(() => { setDraft({ from: parseISO(value.from), to: parseISO(value.to) }); }, [value.from, value.to]);
  return <div aria-label={ariaLabel}><DayPicker locale={zhCN} labels={{ labelPrevious: () => "上个月", labelNext: () => "下个月" }} mode="range" defaultMonth={parseISO(value.from)} selected={draft} disabled={disabled} onSelect={(range) => { setDraft(range); if (range?.from && range.to) onChange({ from: format(range.from, "yyyy-MM-dd"), to: format(range.to, "yyyy-MM-dd") }); }} /></div>;
}
