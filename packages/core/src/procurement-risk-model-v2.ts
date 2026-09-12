export type RiskEvidenceState = 'observed' | 'derived' | 'missing' | 'stale';
export type RiskBand = 'high' | 'medium' | 'low';
export type RiskWeight = 0.30 | 0.25 | 0.20 | 0.15 | 0.10;

export type RiskEvidenceReference = {
  type: string;
  id: string;
  version: number | null;
};

export type RiskComponentInput = {
  score: number | null;
  evidenceState: RiskEvidenceState;
  evidenceReferences: RiskEvidenceReference[];
  observedAt: string | null;
};

export type RiskComponent = RiskComponentInput & {
  weight: RiskWeight;
};

export type RiskModelV2Input = {
  S: RiskComponentInput;
  D: RiskComponentInput;
  V: RiskComponentInput;
  C: RiskComponentInput;
  A: RiskComponentInput;
};

export type RiskModelV2Result = {
  modelVersion: 'risk-model-v2';
  components: {
    supplierPerformance: RiskComponent;
    deliveryDelay: RiskComponent;
    poValue: RiskComponent;
    productCriticality: RiskComponent;
    complianceApproval: RiskComponent;
  };
  evidenceCoverage: number;
  totalScore: number | null;
  provisionalScore: number | null;
  provisionalBand: RiskBand | null;
  band: RiskBand | 'unpublished';
};

const componentDefinitions = [
  ['supplierPerformance', 'S', 0.30],
  ['deliveryDelay', 'D', 0.25],
  ['poValue', 'V', 0.20],
  ['productCriticality', 'C', 0.15],
  ['complianceApproval', 'A', 0.10],
] as const;

export function calculateRiskModelV2(input: RiskModelV2Input): Readonly<RiskModelV2Result> {
  const components = {} as RiskModelV2Result['components'];
  for (const [name, code, weight] of componentDefinitions) {
    const raw = input[code];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${code} risk component is required`);
    if (Object.prototype.hasOwnProperty.call(raw, 'weight')) throw new Error(`${code} weight is fixed by risk-model-v2`);
    components[name] = copyComponent(raw, weight, code);
  }

  const usable = Object.values(components).filter((component) => component.evidenceState === 'observed' || component.evidenceState === 'derived');
  const evidenceCoverage = round(usable.reduce((sum, component) => sum + component.weight, 0), 2);
  const weightedScore = usable.reduce((sum, component) => sum + component.score! * component.weight, 0);
  const totalScore = evidenceCoverage === 1 ? Math.round(weightedScore) : null;
  const deliveryUsable = components.deliveryDelay.evidenceState === 'observed' || components.deliveryDelay.evidenceState === 'derived';
  const provisionalScore = totalScore === null && evidenceCoverage >= 0.70 && deliveryUsable
    ? Math.round(weightedScore / evidenceCoverage)
    : null;
  const result: RiskModelV2Result = {
    modelVersion: 'risk-model-v2',
    components,
    evidenceCoverage,
    totalScore,
    provisionalScore,
    provisionalBand: provisionalScore === null ? null : riskBand(provisionalScore),
    band: totalScore === null ? 'unpublished' : riskBand(totalScore),
  };
  return deepFreeze(result);
}

export function validateRiskModelV2Result(value: RiskModelV2Result): RiskModelV2Result {
  if (!value || typeof value !== 'object' || value.modelVersion !== 'risk-model-v2') throw new Error('risk modelVersion must be risk-model-v2');
  for (const [name, code, weight] of componentDefinitions) {
    const component = value.components?.[name];
    if (!component || component.weight !== weight) throw new Error(`${code} weight must be ${weight}`);
    validateComponent(component, code, true);
  }
  if (!Number.isFinite(value.evidenceCoverage) || value.evidenceCoverage < 0 || value.evidenceCoverage > 1) throw new Error('evidenceCoverage must be between 0 and 1');
  for (const [field, score] of [['totalScore', value.totalScore], ['provisionalScore', value.provisionalScore]] as const) {
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) throw new Error(`${field} must be null or between 0 and 100`);
  }
  return value;
}

function copyComponent(input: RiskComponentInput, weight: RiskWeight, code: string): RiskComponent {
  validateComponent(input, code, false);
  return {
    score: input.score,
    weight,
    evidenceState: input.evidenceState,
    evidenceReferences: input.evidenceReferences.map((reference) => ({ ...reference })),
    observedAt: input.observedAt,
  };
}

function validateComponent(input: RiskComponentInput | RiskComponent, code: string, stored: boolean): void {
  const states: readonly RiskEvidenceState[] = ['observed', 'derived', 'missing', 'stale'];
  if (!states.includes(input.evidenceState)) throw new Error(`${code} evidenceState is invalid`);
  if (input.score !== null && (!Number.isFinite(input.score) || input.score < 0 || input.score > 100)) throw new Error(`${code} score must be null or between 0 and 100`);
  if ((input.evidenceState === 'observed' || input.evidenceState === 'derived') && input.score === null) throw new Error(`${code} usable evidence requires a score`);
  if (input.evidenceState === 'missing' && input.score !== null) throw new Error(`${code} missing evidence requires a null score`);
  if (!Array.isArray(input.evidenceReferences)) throw new Error(`${code} evidenceReferences must be an array`);
  for (const reference of input.evidenceReferences) {
    if (!reference || typeof reference.type !== 'string' || !reference.type.trim() || typeof reference.id !== 'string' || !reference.id.trim()) throw new Error(`${code} evidence reference is invalid`);
    if (reference.version !== null && (!Number.isInteger(reference.version) || reference.version < 1)) throw new Error(`${code} evidence version is invalid`);
  }
  if (input.observedAt !== null && !isRfc3339(input.observedAt)) throw new Error(`${code} observedAt must be RFC3339`);
  if (stored && 'weight' in input && !componentDefinitions.some((definition) => definition[2] === input.weight)) throw new Error(`${code} weight is invalid`);
}

function riskBand(score: number): RiskBand {
  return score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
}

function isRfc3339(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
