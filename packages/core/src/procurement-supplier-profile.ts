export type SupplierRoute = 'local' | 'import' | 'unclassified';
export type SupplierType = 'manufacturer' | 'distributor' | 'service' | 'other';
export type ProductCriticality = 'high' | 'medium' | 'low' | 'unclassified';
export type SupplierOperatingStatus = 'active' | 'inactive';

export type PostalAddress = {
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
};

export type SupplierOperatingProfile = {
  supplierId: string;
  countryCode: string | null;
  route: SupplierRoute;
  supplierType: SupplierType;
  industry: string | null;
  address: PostalAddress | null;
  primaryMaterialCode: string | null;
  primaryMaterialName: string | null;
  defaultLeadTimeDays: number | null;
  productCriticality: ProductCriticality;
  paymentTerms: string | null;
  contractStartsOn: string | null;
  contractEndsOn: string | null;
  status: SupplierOperatingStatus;
  version: number;
};

export class SupplierOperatingProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierOperatingProfileValidationError';
  }
}

/** Validates the shared supplier operating-profile contract without guessing defaults. */
export function validateSupplierOperatingProfile(value: unknown): SupplierOperatingProfile {
  const profile = object(value, 'supplier operating profile');
  only(profile, [
    'supplierId', 'countryCode', 'route', 'supplierType', 'industry', 'address', 'primaryMaterialCode',
    'primaryMaterialName', 'defaultLeadTimeDays', 'productCriticality', 'paymentTerms', 'contractStartsOn',
    'contractEndsOn', 'status', 'version',
  ]);
  const contractStartsOn = nullableIsoDate(profile['contractStartsOn'], 'contractStartsOn');
  const contractEndsOn = nullableIsoDate(profile['contractEndsOn'], 'contractEndsOn');
  if (contractStartsOn !== null && contractEndsOn !== null && contractEndsOn < contractStartsOn) {
    fail('contractEndsOn must be on or after contractStartsOn');
  }
  return {
    supplierId: text(profile['supplierId'], 'supplierId'),
    countryCode: nullableCountryCode(profile['countryCode'], 'countryCode'),
    route: enumValue(profile['route'], ['local', 'import', 'unclassified'], 'route'),
    supplierType: enumValue(profile['supplierType'], ['manufacturer', 'distributor', 'service', 'other'], 'supplierType'),
    industry: nullableString(profile['industry'], 'industry'),
    address: nullableAddress(profile['address']),
    primaryMaterialCode: nullableString(profile['primaryMaterialCode'], 'primaryMaterialCode'),
    primaryMaterialName: nullableString(profile['primaryMaterialName'], 'primaryMaterialName'),
    defaultLeadTimeDays: nullableNonNegativeSafeInteger(profile['defaultLeadTimeDays'], 'defaultLeadTimeDays'),
    productCriticality: enumValue(profile['productCriticality'], ['high', 'medium', 'low', 'unclassified'], 'productCriticality'),
    paymentTerms: nullableString(profile['paymentTerms'], 'paymentTerms'),
    contractStartsOn,
    contractEndsOn,
    status: enumValue(profile['status'], ['active', 'inactive'], 'status'),
    version: positiveSafeInteger(profile['version'], 'version'),
  };
}

function nullableAddress(value: unknown): PostalAddress | null {
  if (value === null) return null;
  const address = object(value, 'address');
  only(address, ['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode']);
  return {
    line1: text(address['line1'], 'address.line1'),
    line2: nullableString(address['line2'], 'address.line2'),
    city: text(address['city'], 'address.city'),
    region: nullableString(address['region'], 'address.region'),
    postalCode: nullableString(address['postalCode'], 'address.postalCode'),
    countryCode: countryCode(address['countryCode'], 'address.countryCode'),
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const key of fields) if (!(key in value)) fail(`${key} is required`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${key} is not allowed`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string or null`);
  return value;
}

function countryCode(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) fail(`${field} must be an ISO 3166-1 alpha-2 code`);
  return value;
}

function nullableCountryCode(value: unknown, field: string): string | null {
  return value === null ? null : countryCode(value, field);
}

function nullableNonNegativeSafeInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${field} must be a non-negative safe integer`);
  return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(`${field} must be a positive safe integer`);
  return value;
}

function nullableIsoDate(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${field} must be an ISO date`);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) {
    fail(`${field} must be a real calendar date`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(`${field} is invalid`);
  return value as T;
}

function fail(message: string): never { throw new SupplierOperatingProfileValidationError(message); }
