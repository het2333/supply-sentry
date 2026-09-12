export type ReadyworkProductVisual =
  | "overview"
  | "notifications"
  | "drafted-emails"
  | "po-timeline"
  | "risk-dashboard"
  | "route-local"
  | "route-import";

const stages = ["订单已发送", "承诺", "生产", "在途", "ERP 收货"] as const;

function StatusPill({ children, tone = "blue" }: { children: React.ReactNode; tone?: "blue" | "amber" | "slate" }) {
  const tones = {
    blue: "border-blue-200 bg-blue-50 text-blue-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    slate: "border-slate-200 bg-slate-50 text-slate-600",
  } as const;
  return <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold ${tones[tone]}`}>{children}</span>;
}

function EmptyCard({ title, copy }: { title: string; copy: string }) {
  return <div className="grid min-h-[142px] place-items-center rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-6 text-center">
    <div>
      <div className="text-sm font-semibold text-slate-800">{title}</div>
      <p className="mt-2 max-w-[320px] text-xs leading-5 text-slate-500">{copy}</p>
    </div>
  </div>;
}

function OverviewVisual() {
  return <div className="grid min-h-[430px] grid-cols-[150px_minmax(0,1fr)] bg-[#f4f7fb] text-left">
    <aside className="border-r border-slate-200 bg-slate-950 p-4 text-white">
      <div className="text-xs font-semibold tracking-wide">READYWORK</div>
      <div className="mt-7 space-y-2">{["总览", "通知", "邮件草稿", "本地采购", "进口采购", "风险看板"].map((item, index) => <div key={item} className={`rounded-lg px-3 py-2 text-[11px] ${index === 0 ? "bg-blue-600 text-white" : "text-slate-400"}`}>{item}</div>)}</div>
    </aside>
    <div className="p-6">
      <div className="flex items-start justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[.14em] text-blue-600">采购执行</p><h3 className="mt-2 text-xl font-semibold text-slate-950">采购总览</h3><p className="mt-1 text-xs text-slate-500">完成连接和验证后，才会显示权威的租户数据。</p></div><StatusPill tone="slate">需要证据</StatusPill></div>
      <div className="mt-6 grid grid-cols-3 gap-3">{["活跃采购订单", "需要关注", "等待回执"].map((label) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-4"><div className="h-2 w-14 rounded bg-slate-200" /><div className="mt-5 text-xs font-medium text-slate-700">{label}</div><div className="mt-1 text-[10px] text-slate-400">暂无持久化数据</div></div>)}</div>
      <div className="mt-4 grid grid-cols-[1.3fr_.7fr] gap-3"><EmptyCard title="暂无持久化的采购订单" copy="连接已批准的来源，或导入已验证的证据，即可填充此工作区。" /><div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs font-semibold text-slate-800">执行门禁</div><div className="mt-4 space-y-3">{["具名采购身份", "SLA 策略", "连接器回执"].map((item) => <div key={item} className="flex items-center gap-2 text-[11px] text-slate-500"><span className="size-2 rounded-full border border-amber-400" />{item}</div>)}</div></div></div>
    </div>
  </div>;
}

function NotificationsVisual() {
  return <div className="min-h-[360px] bg-[#f4f7fb] p-6 text-left">
    <div className="flex items-center justify-between"><div><h3 className="text-lg font-semibold text-slate-950">通知</h3><p className="mt-1 text-xs text-slate-500">只显示已持久化的操作事件。</p></div><StatusPill tone="slate">暂无持久化数据</StatusPill></div>
    <div className="mt-6 grid grid-cols-[180px_minmax(0,1fr)] gap-4"><div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs font-semibold text-slate-800">筛选</div>{["全部", "需要操作", "SLA", "供应商回复"].map((item, index) => <div key={item} className={`mt-2 rounded-lg px-3 py-2 text-[11px] ${index === 0 ? "bg-blue-50 text-blue-700" : "text-slate-500"}`}>{item}</div>)}</div><EmptyCard title="暂无通知" copy="只有 Readywork 记录真实来源事件或策略评估后，才会显示新通知。" /></div>
  </div>;
}

function DraftsVisual() {
  return <div className="min-h-[390px] bg-[#f4f7fb] p-6 text-left">
    <div className="flex items-center justify-between"><div><h3 className="text-lg font-semibold text-slate-950">待审核邮件</h3><p className="mt-1 text-xs text-slate-500">批准发送前，请先审核证据和收件人。</p></div><button type="button" disabled className="rounded-lg bg-slate-200 px-3 py-2 text-[11px] font-semibold text-slate-500">批准并发送</button></div>
    <div className="mt-5 grid grid-cols-[.8fr_1.2fr] gap-4"><div className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex items-center justify-between text-xs font-semibold text-slate-800"><span>等待审核</span><StatusPill tone="slate">0</StatusPill></div><div className="mt-4"><EmptyCard title="暂无持久化的草稿" copy="真实采购订单事件和策略评估完成后，草稿才会出现。" /></div></div><div className="rounded-xl border border-slate-200 bg-white p-5"><div className="text-xs font-semibold text-slate-800">消息审核</div><div className="mt-4 grid grid-cols-[90px_1fr] gap-y-3 text-[11px]"><span className="text-slate-400">收件人</span><span className="text-slate-600">需要证据</span><span className="text-slate-400">主题</span><span className="h-2 rounded bg-slate-100" /><span className="text-slate-400">正文</span><span className="h-20 rounded-lg bg-slate-50" /></div></div></div>
  </div>;
}

function TimelineVisual() {
  return <div className="min-h-[280px] bg-[#f8fafc] p-7 text-left">
    <div className="flex items-center justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[.14em] text-blue-600">采购订单生命周期</p><h3 className="mt-2 text-lg font-semibold text-slate-950">证据支撑的执行</h3></div><StatusPill tone="amber">需要证据</StatusPill></div>
    <ol className="mt-8 grid grid-cols-5">{stages.map((stage, index) => <li key={stage} className="relative pr-3"><span className={`grid size-7 place-items-center rounded-full text-[10px] font-semibold ${index === 0 ? "bg-blue-600 text-white" : "border border-slate-300 bg-white text-slate-400"}`}>{index + 1}</span>{index < stages.length - 1 ? <span className="absolute left-8 right-1 top-3.5 h-px bg-slate-200" /> : null}<div className="mt-3 text-[11px] font-semibold text-slate-700">{stage}</div><div className="mt-1 text-[9px] leading-4 text-slate-400">暂无已核验事件</div></li>)}</ol>
  </div>;
}

function RiskVisual() {
  return <div className="min-h-[390px] bg-[#f4f7fb] p-6 text-left">
    <div className="flex items-start justify-between"><div><h3 className="text-lg font-semibold text-slate-950">风险看板</h3><p className="mt-1 text-xs text-slate-500">风险判定需要证据覆盖率和已持久化的模型快照。</p></div><StatusPill tone="slate">暂无持久化数据</StatusPill></div>
    <div className="mt-6 grid grid-cols-3 gap-3">{["采购组合风险", "证据覆盖率", "模型快照"].map((item) => <div key={item} className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-[11px] font-medium text-slate-600">{item}</div><div className="mt-5 h-2 rounded bg-slate-100" /><div className="mt-2 h-2 w-1/2 rounded bg-slate-100" /></div>)}</div>
    <div className="mt-4 grid grid-cols-[1.2fr_.8fr] gap-3"><div className="rounded-xl border border-slate-200 bg-white p-5"><div className="text-xs font-semibold text-slate-800">风险分布</div><div className="mt-7 flex h-28 items-end gap-4">{[35, 62, 44, 76, 52, 67].map((height, index) => <span key={index} className="flex-1 rounded-t bg-slate-100" style={{ height: `${height}%` }} />)}</div><p className="mt-4 text-center text-[10px] text-slate-400">仅为示意几何图形 · 不含业务数值</p></div><EmptyCard title="需要证据" copy="看板不会因缺少采购订单证据而推断为低风险。" /></div>
  </div>;
}

function RouteVisual({ route }: { route: "本地采购" | "进口采购" }) {
  return <div className="min-h-[220px] bg-[#f8fafc] p-5 text-left">
    <div className="flex items-center justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[.14em] text-blue-600">{route}路线</p><h3 className="mt-2 text-base font-semibold text-slate-950">路线工作台</h3></div><StatusPill tone="amber">需要证据</StatusPill></div>
    <div className="mt-5"><EmptyCard title={`暂无持久化的${route}订单`} copy="只有已核验来源或可审计的人工决策完成后，才会显示路线分配。" /></div>
  </div>;
}

export function ReadyworkProductVisual({ kind }: { kind: ReadyworkProductVisual }): React.JSX.Element {
  if (kind === "overview") return <OverviewVisual />;
  if (kind === "notifications") return <NotificationsVisual />;
  if (kind === "drafted-emails") return <DraftsVisual />;
  if (kind === "po-timeline") return <TimelineVisual />;
  if (kind === "risk-dashboard") return <RiskVisual />;
  if (kind === "route-local") return <RouteVisual route="本地采购" />;
  return <RouteVisual route="进口采购" />;
}
