import type { DatabaseSync } from 'node:sqlite';

/** Durable, tenant-scoped storage for the Manufacturing Context/Twin. */
export const MANUFACTURING_CONTEXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS twin_entities (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  source_watermark TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, entity_type, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_twin_entities_lookup
  ON twin_entities (tenant_id, entity_type, canonical_key);

CREATE TABLE IF NOT EXISTS twin_relations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','disputed')),
  source_evidence_id TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, relation_type, from_entity_id, to_entity_id, source_evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_twin_relations_from
  ON twin_relations (tenant_id, from_entity_id, relation_type, status);
CREATE INDEX IF NOT EXISTS idx_twin_relations_to
  ON twin_relations (tenant_id, to_entity_id, relation_type, status);

CREATE TABLE IF NOT EXISTS twin_evidence (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  entity_id TEXT,
  relation_id TEXT,
  source_semantics TEXT NOT NULL CHECK (source_semantics IN ('verified_external','approved_human','deterministic','model_derived','observed_backfill')),
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  fact_path TEXT NOT NULL,
  value_json TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority IN (100,200,300,400)),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  effective_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  raw_reference_json TEXT NOT NULL,
  supersedes_evidence_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (entity_id IS NOT NULL OR relation_id IS NOT NULL),
  UNIQUE (tenant_id, source_kind, source_id, source_version, fact_path, source_hash)
);
CREATE INDEX IF NOT EXISTS idx_twin_evidence_entity
  ON twin_evidence (tenant_id, entity_id, fact_path, priority DESC, effective_at DESC, observed_at DESC, id);

CREATE TABLE IF NOT EXISTS twin_agent_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  temporal_workflow_id TEXT,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  business_object_id TEXT,
  entity_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('context_read','extraction','decision','recommendation','action_requested','action_result','human_feedback','business_outcome')),
  input_snapshot_id TEXT,
  model TEXT,
  reasoning_profile TEXT,
  prompt_hash TEXT,
  response_hash TEXT,
  action_name TEXT,
  status TEXT NOT NULL,
  confidence REAL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_ids_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_twin_agent_events_entity_time
  ON twin_agent_events (tenant_id, entity_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS twin_snapshots (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  root_entity_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version = 'manufacturing-context/v1'),
  source_watermark TEXT NOT NULL,
  permission_fingerprint TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_twin_snapshots_root_time
  ON twin_snapshots (tenant_id, root_entity_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS twin_projection_jobs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','retry_wait','succeeded','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts = 8),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  projected_watermark TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_table, source_key, source_revision, event_type)
);
CREATE INDEX IF NOT EXISTS idx_twin_projection_jobs_claim
  ON twin_projection_jobs (tenant_id, status, available_at, lease_expires_at, created_at, id);

CREATE TRIGGER IF NOT EXISTS trg_twin_evidence_no_update
BEFORE UPDATE ON twin_evidence
BEGIN
  SELECT RAISE(ABORT, 'twin_evidence is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_twin_evidence_no_delete
BEFORE DELETE ON twin_evidence
BEGIN
  SELECT RAISE(ABORT, 'twin_evidence is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_twin_agent_events_no_update
BEFORE UPDATE ON twin_agent_events
BEGIN
  SELECT RAISE(ABORT, 'twin_agent_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_twin_agent_events_no_delete
BEFORE DELETE ON twin_agent_events
BEGIN
  SELECT RAISE(ABORT, 'twin_agent_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_twin_snapshots_no_update
BEFORE UPDATE ON twin_snapshots
BEGIN
  SELECT RAISE(ABORT, 'twin_snapshots is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_twin_snapshots_no_delete
BEFORE DELETE ON twin_snapshots
BEGIN
  SELECT RAISE(ABORT, 'twin_snapshots is append-only');
END;
`;

/** Cross-process worker liveness for the split business/control deployment. */
export const MANUFACTURING_CONTEXT_RUNTIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS twin_projection_worker_heartbeats (
  tenant_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  worker_ready INTEGER NOT NULL CHECK (worker_ready IN (0,1)),
  last_heartbeat_at TEXT NOT NULL,
  poll_interval_ms INTEGER NOT NULL CHECK (poll_interval_ms > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, worker_id)
);
CREATE INDEX IF NOT EXISTS idx_twin_projection_worker_heartbeats_latest
  ON twin_projection_worker_heartbeats (tenant_id, last_heartbeat_at DESC, worker_id);
`;

export function ensureManufacturingContextSchema(db: DatabaseSync): void {
  db.exec(`${MANUFACTURING_CONTEXT_SCHEMA}\n${MANUFACTURING_CONTEXT_RUNTIME_SCHEMA}`);
}
