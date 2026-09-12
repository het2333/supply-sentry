export type ManufacturingContextPanelState<T> = {
  envelope: T | null;
  error: string | null;
  loading: boolean;
  notice: string | null;
};

export type ManufacturingContextDisclosureAction = "toggle" | "object_changed";

export function manufacturingContextExpandedState(
  current: boolean,
  action: ManufacturingContextDisclosureAction,
): boolean {
  return action === "object_changed" ? false : !current;
}

export function beginManufacturingContextLoad<T>(
  current: ManufacturingContextPanelState<T>,
  options: { objectChanged: boolean; preserveNotice: boolean },
): ManufacturingContextPanelState<T> {
  return {
    envelope: options.objectChanged ? null : current.envelope,
    error: null,
    loading: true,
    notice: options.preserveNotice ? current.notice : null,
  };
}
