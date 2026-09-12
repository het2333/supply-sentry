import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  activeEmployeePack,
  buildEmployeePackNavigationGroups,
  buildEmployeePackSidebarGroups,
  employeePackViewModeFromNavigationValue,
  parseEmployeePackCatalog,
  preferredEmployeeId,
  resolveEmployeePackSection,
  type EmployeePackManifestView,
} from '../features/platform/employee-packs.js';

const pageSource = readFileSync(fileURLToPath(new URL('../app/page.tsx', import.meta.url)), 'utf8');

function manifest(): EmployeePackManifestView {
  return {
    id: 'capability:test', version: '1.0.0', name: 'Test', description: 'Test pack', defaultEmployeeId: 'ai:preferred',
    branding: { productName: 'READYWORK', employeeSubtitle: '测试员工', workspaceLabel: '测试工作台', themeId: 'test' },
    interfaces: {
      business: {
        id: 'business', label: '业务', enabled: true, defaultSectionId: 'home', ownedSectionIds: ['home', 'tasks'],
        navigationGroups: [{ id: 'work', label: '工作', items: [{ id: 'home', label: '总览', icon: 'home' }, { id: 'tasks', label: '任务', icon: 'tasks' }] }],
      },
      developer: { id: 'developer', label: '开发者', enabled: true, defaultSectionId: 'employees', ownedSectionIds: ['employees'], navigationGroups: [] },
    },
    lifecycle: {
      entityType: 'purchase_order', startStageId: 'po-sent', terminalStageId: 'grn',
      stages: [
        { id: 'po-sent', label: 'PO Sent', description: '已发出', workflowIds: ['po-operations'] },
        { id: 'grn', label: 'GRN', description: '最终收货', workflowIds: ['delivery-receipt'] },
      ],
    },
  };
}

test('Console Employee Pack: 服务端 Manifest 驱动导航和首选员工', () => {
  const raw = { items: [{ manifest: manifest(), installed: true, employeeIds: ['ai:preferred'] }] };
  const catalog = parseEmployeePackCatalog(raw);
  assert.equal(activeEmployeePack(catalog, 'ai:preferred')?.manifest.id, 'capability:test');
  assert.deepEqual(catalog.items[0]!.manifest.lifecycle?.stages.map((stage) => stage.label), ['PO Sent', 'GRN']);
  assert.equal(preferredEmployeeId(catalog, ['ai:other', 'ai:preferred']), 'ai:preferred');
  assert.deepEqual(buildEmployeePackNavigationGroups(catalog.items[0]!.manifest, { home: 'H', tasks: 'T' }), [
    { id: 'work', label: '工作', items: [{ id: 'home', label: '总览', icon: 'H' }, { id: 'tasks', label: '任务', icon: 'T' }] },
  ]);
});

test('Console Employee Pack: 无标题单组只呈现十项业务入口且不泄漏深链 ownership', () => {
  const pack = manifest();
  pack.branding.themeId = 'readywork-procurement';
  pack.interfaces.business.ownedSectionIds = [
    'home', 'notifications', 'message-drafts', 'po-intake', 'local-procurement',
    'import-procurement', 'risk-dashboard', 'orders', 'suppliers', 'sla', 'advanced-sla', 'settings',
  ];
  pack.interfaces.business.navigationGroups = [{
    id: 'procurement',
    label: '',
    items: [
      { id: 'home', label: '总览', icon: 'layout-dashboard' },
      { id: 'notifications', label: '通知', icon: 'bell' },
      { id: 'message-drafts', label: '邮件草稿', icon: 'mail' },
      { id: 'local-procurement', label: '本地采购', icon: 'shopping-cart' },
      { id: 'import-procurement', label: '进口采购', icon: 'globe-2' },
      { id: 'risk-dashboard', label: '风险看板', icon: 'activity' },
      { id: 'suppliers', label: '供应商', icon: 'users-round' },
      { id: 'sla', label: '服务等级', icon: 'clock-3' },
      { id: 'advanced-sla', label: '高级服务等级', icon: 'shield-check' },
      { id: 'settings', label: '自动跟单', icon: 'settings' },
    ],
  }];
  const icons = Object.fromEntries(pack.interfaces.business.navigationGroups[0]!.items.map((item) => [item.icon, item.icon]));
  const groups = buildEmployeePackNavigationGroups(pack, icons);

  assert.equal(groups[0]!.label, '');
  assert.deepEqual(groups[0]!.items.map(({ id, label }) => [id, label]), [
    ['home', '总览'],
    ['notifications', '通知'],
    ['message-drafts', '邮件草稿'],
    ['local-procurement', '本地采购'],
    ['import-procurement', '进口采购'],
    ['risk-dashboard', '风险看板'],
    ['suppliers', '供应商'],
    ['sla', '服务等级'],
    ['advanced-sla', '高级服务等级'],
    ['settings', '自动跟单'],
  ]);
  assert.equal(groups[0]!.items.some((item) => item.id === 'orders' || item.id === 'po-intake'), false);

  const sidebarGroups = buildEmployeePackSidebarGroups(pack, icons);
  assert.deepEqual(sidebarGroups.map(({ id, label }) => [id, label]), [
    ['procurement-overview', ''],
    ['procurement-communications', ''],
    ['procurement-routes', '采购路径'],
    ['procurement-reports', '报表'],
    ['procurement-settings', '设置'],
  ]);
  assert.deepEqual(sidebarGroups.map((group) => group.items.map((item) => item.id)), [
    ['home'],
    ['notifications', 'message-drafts'],
    ['local-procurement', 'import-procurement'],
    ['risk-dashboard'],
    ['suppliers', 'sla', 'advanced-sla', 'settings'],
  ]);
  assert.deepEqual(
    sidebarGroups.flatMap((group) => group.items).map((item) => item.id),
    groups.flatMap((group) => group.items).map((item) => item.id),
    '参考站分组只能重排 Manifest 已公布的入口，不能遗漏或伪造路由',
  );
});

test('Console Employee Pack: 非法 section、未知图标和空清单均 fail closed', () => {
  assert.throws(() => parseEmployeePackCatalog({}), /格式无效/);
  const invalidSection = manifest();
  invalidSection.interfaces.business.navigationGroups[0]!.items[0]!.id = 'not-a-readywork-section';
  assert.throws(() => buildEmployeePackNavigationGroups(invalidSection, { home: 'H', tasks: 'T' }), /未知入口/);

  const unknownIcon = manifest();
  unknownIcon.interfaces.business.navigationGroups[0]!.items[0]!.icon = 'unknown';
  assert.throws(() => buildEmployeePackNavigationGroups(unknownIcon, { home: 'H', tasks: 'T' }), /图标未注册/);
  assert.equal(activeEmployeePack({ items: [] }, 'ai:none'), null);
});

test('Console Employee Pack: 深链只能进入当前 Pack 声明的业务或开发者页面', () => {
  const pack = manifest();
  assert.equal(employeePackViewModeFromNavigationValue('developer'), 'developer');
  assert.equal(employeePackViewModeFromNavigationValue('business'), 'business');
  assert.equal(employeePackViewModeFromNavigationValue('admin'), 'business');
  assert.equal(employeePackViewModeFromNavigationValue(null), 'business');
  assert.deepEqual(resolveEmployeePackSection(pack, 'home', 'business'), { section: 'home', redirected: false });
  assert.deepEqual(resolveEmployeePackSection(pack, 'employees', 'developer'), { section: 'employees', redirected: false });
  assert.deepEqual(resolveEmployeePackSection(pack, 'sourcing', 'business'), { section: 'home', redirected: true });
  assert.deepEqual(resolveEmployeePackSection(pack, 'employees', 'business'), { section: 'home', redirected: true });
});

test('Console Employee Pack: 显式开发者深链写入并恢复 view 参数', () => {
  assert.match(pageSource, /url\.searchParams\.set\("view", "developer"\)/);
  assert.match(pageSource, /resolveNavigationViewMode\(requestedSection, url\.searchParams\.get\("view"\)\)/);
  assert.match(pageSource, /navigateToSection\("employees", \{ viewMode: "developer" \}\)/);
  assert.match(pageSource, /url\.searchParams\.delete\("view"\)/);
});
