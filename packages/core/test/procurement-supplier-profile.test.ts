import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateSupplierOperatingProfile,
} from '@readywork/core';
import type { PostalAddress, SupplierOperatingProfile } from '@readywork/core';

const validAddress: PostalAddress = {
  line1: '1 Procurement Way',
  line2: null,
  city: 'Shenzhen',
  region: null,
  postalCode: '518000',
  countryCode: 'CN',
};

const validProfile: SupplierOperatingProfile = {
  supplierId: 'supplier:acme',
  countryCode: 'CN',
  route: 'import',
  supplierType: 'manufacturer',
  industry: 'Industrial components',
  address: validAddress,
  primaryMaterialCode: 'BOLT-M8',
  primaryMaterialName: 'M8 bolt',
  defaultLeadTimeDays: 14,
  productCriticality: 'high',
  paymentTerms: 'Net 30',
  contractStartsOn: '2026-02-28',
  contractEndsOn: '2026-02-28',
  status: 'active',
  version: 1,
};

test('supplier operating profile accepts the exact shared contract', () => {
  assert.deepEqual(validateSupplierOperatingProfile(validProfile), validProfile);
  assert.deepEqual(validateSupplierOperatingProfile({
    ...validProfile,
    countryCode: null,
    address: null,
    defaultLeadTimeDays: null,
    contractStartsOn: null,
    contractEndsOn: null,
    route: 'unclassified',
    supplierType: 'other',
    productCriticality: 'unclassified',
    status: 'inactive',
  }), {
    ...validProfile,
    countryCode: null,
    address: null,
    defaultLeadTimeDays: null,
    contractStartsOn: null,
    contractEndsOn: null,
    route: 'unclassified',
    supplierType: 'other',
    productCriticality: 'unclassified',
    status: 'inactive',
  });
});

test('supplier operating profile rejects invalid enum values, calendar dates, unsafe lead times, and inverted contracts', () => {
  assert.throws(() => validateSupplierOperatingProfile({ ...validProfile, route: 'domestic' }), /route/u);
  assert.throws(() => validateSupplierOperatingProfile({ ...validProfile, supplierType: 'broker' }), /supplierType/u);
  assert.throws(() => validateSupplierOperatingProfile({ ...validProfile, productCriticality: 'critical' }), /productCriticality/u);
  assert.throws(() => validateSupplierOperatingProfile({ ...validProfile, status: 'paused' }), /status/u);
  assert.throws(() => validateSupplierOperatingProfile({ ...validProfile, contractStartsOn: '2026-02-29' }), /contractStartsOn/u);
  assert.throws(() => validateSupplierOperatingProfile({ ...validProfile, defaultLeadTimeDays: -1 }), /defaultLeadTimeDays/u);
  assert.throws(() => validateSupplierOperatingProfile({ ...validProfile, defaultLeadTimeDays: Number.MAX_SAFE_INTEGER + 1 }), /defaultLeadTimeDays/u);
  assert.throws(() => validateSupplierOperatingProfile({ ...validProfile, contractEndsOn: '2026-02-27' }), /contractEndsOn/u);
  assert.throws(() => validateSupplierOperatingProfile({
    ...validProfile,
    address: { ...validAddress, countryCode: 'China' },
  }), /address\.countryCode/u);
});
