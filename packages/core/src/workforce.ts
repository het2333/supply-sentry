import type { EmployeeSpec } from './employee-spec.js';
import type { AIEmployee } from './org.js';
import type { EntityId, ISODateTime } from './types.js';

/** AI Workforce 控制面的稳定员工身份；执行能力通过不可变版本发布。 */
export interface EmployeeDefinition {
  id: EntityId;
  tenantId: EntityId;
  name: string;
  role: string;
  departmentId: EntityId;
  managerId?: EntityId;
  capabilityPackIds: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface EmployeeVersion {
  id: EntityId;
  tenantId: EntityId;
  employeeId: EntityId;
  version: string;
  spec: EmployeeSpec;
  capabilityPackIds: string[];
  workflowIds: string[];
  permissionPolicyId?: string;
  ruleSetId?: string;
  connectorGrantIds: string[];
  createdAt: ISODateTime;
}

export interface EmployeeDeployment {
  tenantId: EntityId;
  employeeId: EntityId;
  versionId: EntityId;
  deployMode: 'shadow' | 'supervised' | 'autonomous';
  activeWorkflowVersionId?: string;
  permissionPolicyId?: string;
  ruleSetId?: string;
  connectorGrantIds: string[];
  updatedAt: ISODateTime;
}

export interface WorkforceEmployeeSnapshot {
  definition: EmployeeDefinition;
  version: EmployeeVersion;
  deployment: EmployeeDeployment;
  runtimeEmployee?: AIEmployee;
}
