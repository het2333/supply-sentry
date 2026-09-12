import { createHash } from 'node:crypto';
import { redactSensitive, type TwinAccessScope, type TwinEntityType } from '@readywork/core';

const INVALID_JSON_MESSAGE = 'Twin JSON 值无效';
const SECRET_KEYS = new Set([
  'authorization', 'authorizationheader', 'apikey', 'token', 'accesstoken', 'refreshtoken',
  'idtoken', 'authtoken', 'bearertoken', 'secret', 'clientsecret', 'apisecret', 'secretkey',
  'password', 'passwd', 'passphrase', 'credential', 'credentials', 'cookie', 'cookies',
  'cookiejar', 'sessioncookie',
]);
const COMMERCIAL_KEYS = new Set([
  'commercialterm', 'commercialterms', 'paymentterm', 'paymentterms', 'incoterm', 'incoterms',
  'unitprice', 'price', 'cost', 'amount', 'netamount', 'total', 'currency', 'discount', 'tax',
  'rate', 'budget',
]);
const COMMERCIAL_WORDS = new Set([
  'price', 'cost', 'amount', 'total', 'currency', 'discount', 'tax', 'rate', 'budget',
]);
const EMAIL_KEYS = new Set([
  'email', 'emailaddress', 'mailaddress', 'contactemail', 'contactemails', 'emails',
]);
const PHONE_KEYS = new Set([
  'phone', 'phones', 'phonenumber', 'phonenumbers', 'contactphone', 'contactphones',
  'mobile', 'mobiles', 'mobilenumber', 'mobilenumbers', 'telephone', 'telephones',
  'telephonenumber', 'telephonenumbers', 'tel',
]);
const EMAIL_CONTENT_KEYS = new Set(['rawbody', 'rawemailbody', 'emailbody', 'bodyhtml', 'bodytext']);
const ATTACHMENT_CONTENT_KEYS = new Set([
  'bytes', 'contentbytes', 'attachmentbytes', 'attachmentcontent', 'base64', 'data',
]);
const DIRECT_ATTACHMENT_CONTENT_KEYS = new Set(['attachmentbytes', 'attachmentcontent']);
const EMAIL_CONTAINER_KEYS = new Set([
  'email', 'emails', 'mail', 'mails', 'message', 'messages', 'communication', 'communications',
  'emailmessage', 'emailmessages', 'mailmessage', 'mailmessages', 'emailpacket', 'emailpackets',
]);
const ATTACHMENT_CONTAINER_KEYS = new Set([
  'attachment', 'attachments', 'attachmentrecord', 'attachmentrecords',
  'file', 'files', 'document', 'documents',
]);
const INLINE_CREDENTIAL_ASSIGNMENT = /(authorization|api[-_]?key|token|secret|password|passwd|passphrase|credential|cookie)\s*[=:]/i;

/** Exact operate purposes whose real procurement action requires prices or terms. */
export const OPERATE_COMMERCIAL_SNAPSHOT_PURPOSES = [
  'po_supplier_commitment',
  'quote_comparison',
  'create_odoo_po_draft',
  'send_po',
  'record_confirmation',
  'record_invoice',
  'match_invoice',
] as const;

const OPERATE_COMMERCIAL_PURPOSE_SET = new Set<string>(OPERATE_COMMERCIAL_SNAPSHOT_PURPOSES);

function invalidJson(): never {
  throw new Error(INVALID_JSON_MESSAGE);
}

export function normalizeContextFieldKey(key: string): string {
  return key.toLowerCase().replace(/[\s._-]+/g, '');
}

function contextPathSegments(key: string): string[] {
  return key.split(/[.\/[\]]+/).filter((segment) => segment.length > 0);
}

function contextFieldWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function pathHasContainerAlias(path: readonly string[], aliases: ReadonlySet<string>): boolean {
  return path.some((segment) => aliases.has(normalizeContextFieldKey(segment)));
}

export function canonicalContextJson(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : invalidJson();
  if (typeof value !== 'object') return invalidJson();
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return invalidJson();
    if (ancestors.has(value)) return invalidJson();
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string') return invalidJson();
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) return invalidJson();
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) return invalidJson();
        items.push(canonicalContextJson(descriptor.value, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return invalidJson();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return invalidJson();
      entries.push([key, descriptor.value]);
    }
    entries.sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalContextJson(item, ancestors)}`).join(',')}}`;
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_JSON_MESSAGE) throw error;
    return invalidJson();
  } finally {
    ancestors.delete(value);
  }
}

function containsInlineCredential(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.includes('bearer ')) return true;
  if (lower.includes('://') && /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i.test(value)) return true;
  return /(authorization|api|key|token|secret|password|passwd|passphrase|credential|cookie)/i.test(value)
    && INLINE_CREDENTIAL_ASSIGNMENT.test(value);
}

function sanitizeString(value: string): string {
  return containsInlineCredential(value) ? redactSensitive(value, Math.max(value.length * 2, 20_000)) : value;
}

export interface ContextAccessScope extends TwinAccessScope {
  includeProjectionHealth: boolean;
}

export interface ContextScopeOptions {
  entityTypes?: readonly TwinEntityType[];
  purpose?: string;
  /** @deprecated Deliberately ignored as an authorization source. */
  requiresCommercialTerms?: boolean;
}

export function scopeForSession(
  permission: TwinAccessScope['permission'],
  options: ContextScopeOptions = {},
): ContextAccessScope {
  const entityTypes = [...(options.entityTypes ?? [])];
  if (permission === 'read') {
    return { permission, entityTypes, includeContactDetails: false, includeCommercialTerms: false, includeProjectionHealth: false };
  }
  if (permission === 'operate') {
    return {
      permission,
      entityTypes,
      includeContactDetails: true,
      includeCommercialTerms: typeof options.purpose === 'string'
        && OPERATE_COMMERCIAL_PURPOSE_SET.has(options.purpose),
      includeProjectionHealth: false,
    };
  }
  if (permission === 'approve') {
    return { permission, entityTypes, includeContactDetails: true, includeCommercialTerms: true, includeProjectionHealth: false };
  }
  if (permission === 'configure' || permission === 'admin') {
    return { permission, entityTypes, includeContactDetails: true, includeCommercialTerms: true, includeProjectionHealth: true };
  }
  throw new Error('Twin 权限类型不受支持');
}

export function maskEmail(value: string): string {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) return '***';
  const local = value.slice(0, separator);
  return `${local.slice(0, 1)}***${value.slice(separator)}`;
}

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

export function isCommercialFieldName(key: string): boolean {
  return contextPathSegments(key).some((segment) => (
    COMMERCIAL_KEYS.has(normalizeContextFieldKey(segment))
    || contextFieldWords(segment).some((word) => COMMERCIAL_WORDS.has(word))
  ));
}

export function isRestrictedFieldName(key: string): boolean {
  return contextPathSegments(key).some((segment) => SECRET_KEYS.has(normalizeContextFieldKey(segment)));
}

type ContactKind = 'email' | 'phone';

function contactKindForKey(key: string): ContactKind | undefined {
  const normalized = normalizeContextFieldKey(key);
  if (EMAIL_KEYS.has(normalized)) return 'email';
  if (PHONE_KEYS.has(normalized)) return 'phone';
  return undefined;
}

function genericContactValueKey(key: string): boolean {
  return ['value', 'address', 'number', 'email', 'phone', 'mobile', 'telephone', 'tel']
    .includes(normalizeContextFieldKey(key));
}

function dataEntries(object: object): Array<readonly [string, unknown]> {
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string') return invalidJson();
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalidJson();
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function stringField(object: Record<string, unknown>, normalizedKeys: readonly string[]): string | undefined {
  for (const [key, value] of dataEntries(object)) {
    if (!normalizedKeys.includes(normalizeContextFieldKey(key))) continue;
    if (typeof value === 'string' && value.length > 0) return sanitizeString(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function restrictedContentFieldKind(
  key: string,
  path: readonly string[],
): 'email-body' | 'attachment' | undefined {
  const normalizedKey = normalizeContextFieldKey(key);
  if (EMAIL_CONTENT_KEYS.has(normalizedKey)) return 'email-body';
  if (pathHasContainerAlias(path, EMAIL_CONTAINER_KEYS)
    && (normalizedKey === 'body' || normalizedKey === 'content')) return 'email-body';
  if (DIRECT_ATTACHMENT_CONTENT_KEYS.has(normalizedKey)) return 'attachment';
  if (ATTACHMENT_CONTENT_KEYS.has(normalizedKey)
    && pathHasContainerAlias(path, ATTACHMENT_CONTAINER_KEYS)) return 'attachment';
  if (pathHasContainerAlias(path, ATTACHMENT_CONTAINER_KEYS)
    && (normalizedKey === 'content' || normalizedKey === 'file')) return 'attachment';
  return undefined;
}

function restrictedReference(
  object: Record<string, unknown>,
  path: readonly string[],
  kind: 'email-body' | 'attachment',
): Record<string, unknown> {
  const sourceObjectId = stringField(object, [
    'sourceobjectid', 'attachmentid', 'messageid', 'emailid', 'sourceid', 'objectid', 'id',
  ]);
  const contentHash = stringField(object, ['contenthash', 'sha256', 'sourcehash', 'hash'])
    ?? createHash('sha256').update(canonicalContextJson(object)).digest('hex');
  return {
    sourceObjectId: sourceObjectId
      ?? `restricted:${kind}:${createHash('sha256').update(path.join('.')).digest('hex').slice(0, 16)}`,
    contentHash,
    restricted: true,
  };
}

export interface SanitizeContextOptions {
  includeContactDetails: boolean;
  includeCommercialTerms: boolean;
}

function sanitizeValidated(
  value: unknown,
  options: SanitizeContextOptions,
  path: readonly string[],
  contactKind?: ContactKind,
): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (!options.includeContactDetails && contactKind === 'email') return maskEmail(value);
    if (!options.includeContactDetails && contactKind === 'phone') return maskPhone(value);
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) return invalidJson();
      output.push(sanitizeValidated(descriptor.value, options, [...path, String(index)], contactKind));
    }
    return output;
  }
  if (typeof value !== 'object') return invalidJson();
  const object = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of dataEntries(object)) {
    if (isRestrictedFieldName(key)) continue;
    if (!options.includeCommercialTerms && isCommercialFieldName(key)) continue;
    const restrictedKind = restrictedContentFieldKind(key, path);
    if (restrictedKind) {
      output[key] = restrictedReference(object, [...path, key], restrictedKind);
      continue;
    }
    const directContactKind = contactKindForKey(key);
    const inheritedContactKind = contactKind !== undefined
      && (genericContactValueKey(key) || (typeof item === 'object' && item !== null)) ? contactKind : undefined;
    output[key] = sanitizeValidated(item, options, [...path, key], directContactKind ?? inheritedContactKind);
  }
  return output;
}

/** Validates the complete graph before reading values, then returns a fresh sanitized JSON value. */
export function sanitizeContextValue(
  value: unknown,
  options: SanitizeContextOptions,
  path: readonly string[] = [],
): unknown {
  canonicalContextJson(value);
  return sanitizeValidated(value, options, path);
}
