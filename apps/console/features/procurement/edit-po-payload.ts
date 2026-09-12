export type EditPurchaseOrderLine = {
  id: string;
  itemCode: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  taxRate: number | null;
};

export type EditPurchaseOrderValues = {
  supplierId: string;
  contactId: string | null;
  requiredInHouseAt: string;
  materialType: 'direct' | 'indirect';
  lines: EditPurchaseOrderLine[];
};

export type EditPurchaseOrderPatch = Partial<EditPurchaseOrderValues>;

export function buildEditPurchaseOrderPatch(
  baseline: EditPurchaseOrderValues,
  current: EditPurchaseOrderValues,
  options: { external?: boolean } = {},
): EditPurchaseOrderPatch {
  const patch: EditPurchaseOrderPatch = {};
  if (baseline.requiredInHouseAt !== current.requiredInHouseAt) patch.requiredInHouseAt = current.requiredInHouseAt;
  if (options.external) return patch;
  if (baseline.supplierId !== current.supplierId) patch.supplierId = current.supplierId;
  if (baseline.contactId !== current.contactId) patch.contactId = current.contactId;
  if (baseline.materialType !== current.materialType) patch.materialType = current.materialType;
  if (JSON.stringify(baseline.lines) !== JSON.stringify(current.lines)) patch.lines = current.lines;
  return patch;
}
