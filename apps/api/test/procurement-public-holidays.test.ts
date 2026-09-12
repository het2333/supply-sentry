import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  procurementPublicHolidaySnapshot,
  supportsProcurementPublicHolidays,
} from '../src/procurement-public-holidays.js';

test('公共节假日快照冻结国家、年份、实际日期、来源版本和许可', () => {
  assert.equal(supportsProcurementPublicHolidays('CN'), true);
  assert.equal(supportsProcurementPublicHolidays('ZZ'), false);
  const snapshot = procurementPublicHolidaySnapshot('CN', new Date('2026-08-21T14:00:00.000Z'));
  assert.equal(snapshot.countryCode, 'CN');
  assert.deepEqual(snapshot.years, [2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029]);
  assert.equal(snapshot.dates.includes('2026-01-01'), true);
  assert.equal(snapshot.source, 'date-holidays');
  assert.equal(snapshot.sourceVersion, '3.36.0');
  assert.equal(snapshot.sourceLicense, 'ISC AND CC-BY-3.0');

  snapshot.dates.length = 0;
  assert.equal(
    procurementPublicHolidaySnapshot('CN', new Date('2026-08-21T14:00:00.000Z')).dates.includes('2026-01-01'),
    true,
    'callers cannot mutate the cached evidence used by later evaluations',
  );
  assert.throws(() => procurementPublicHolidaySnapshot('ZZ', Date.now()), /不支持 ZZ/);
});
