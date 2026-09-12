import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/features/marketing/legal-page";

export const metadata: Metadata = {
  title: "使用条款 | Readywork 采购执行",
  description: "Readywork 采购执行公开产品页的预发布网站使用条款。",
};

const sections: LegalSection[] = [
  {
    id: "scope",
    title: "关于本条款",
    content: <><p>本预发布条款说明公开产品网站及演示申请表的使用方式，不适用于采购工作区的试点、试用或生产部署。</p><p>商业平台访问必须另行签署协议，约定范围、费用、服务等级、数据保护、保密、支持、责任及终止安排。</p></>,
  },
  {
    id: "status",
    title: "预发布产品状态",
    content: <><p>本产品仍处于 V1 主动验证阶段，尚不代表已经普遍可用。截图用于说明预期交互模型；已登录工作区中的业务记录来自已连接的租户系统，不会依据截图生成。</p><p>具名身份、已发布的 SLA 策略、已核验的采购路径证据以及真实的采购订单到收货单闭环，仍是生产启用门槛。</p></>,
  },
  {
    id: "permitted-use",
    title: "允许的使用方式",
    content: <><p>您可以使用公开页面评估产品、在内部分享页面用于该项评估，并使用您有权提供的信息提交真实的演示申请。</p><p>已登录工作区仅限部署负责人授权的账号及租户数据访问。</p></>,
  },
  {
    id: "prohibited-use",
    title: "禁止的使用方式",
    content: <><p>您不得尝试未经授权的访问、跨越租户边界、植入恶意软件、使接口过载、绕过审批或连接器门禁、未经授权提交他人信息，或将系统生成的建议歪曲为已批准的业务决定。</p><p>供应商附件和消息属于不可信输入，不得用于指示系统执行获批采购工作流以外的操作。</p></>,
  },
  {
    id: "demo",
    title: "演示申请",
    content: <><p>提交演示表单仅构成咨询。API 接受请求仅表示已校验的申请及审计事件已持久化；这不会订立合同、保证回复时间、启动试点，也不会授权电子邮件、ERP 或供应商操作。</p><p>任何范围、时间、价格或生产承诺均须另行书面约定。</p></>,
  },
  {
    id: "platform-agreement",
    title: "平台协议与客户授权",
    content: <><p>客户组织仍须对采购授权、供应商关系、合法指令、业务规则、获批用户以及提供给平台的 ERP 和通信数据准确性负责。</p><p>对于任何试点或生产部署，已签署的平台协议优先于本网站内容。</p></>,
  },
  {
    id: "supervision",
    title: "AI 输出、人工监督与外部操作",
    content: <><p>AI 摘要、提取结果和建议可能不完整或有误，必须结合上下文复核。重大差异仍由人工决策。</p><p>界面标签或草稿不能证明邮件已经发送、ERP 已经更新或阶段已经完成。只有已配置连接器返回可核验回执并由审计链记录后，系统才确认这些结果。</p></>,
  },
  {
    id: "intellectual-property",
    title: "知识产权与第三方材料",
    content: <><p>第三方名称、标识、软件库和服务仍归各自权利人所有。提及 SAP、QuickBooks、Gmail、Outlook、Office 365、WhatsApp、WeChat 或 Odoo，不代表存在关联或获得其认可。</p><p>Readywork 公开视觉素材为自有内容。软件库和服务依照第三方组件许可清单审核；未取得生产使用权的组件不得用于商业发布。</p></>,
  },
  {
    id: "availability",
    title: "可用性与保证",
    content: <><p>公开网站和预发布工作区可能变更、暂停或存在缺陷。本页不构成对生产可用时间、响应时间、集成或业务结果的保证。</p><p>生产保证和服务等级必须在已签署的客户协议中明确，并由已部署的监控及恢复控制提供支持。</p></>,
  },
  {
    id: "liability-contact",
    title: "责任、适用法律与联系渠道",
    content: <><p>责任限制、赔偿、适用法律、管辖、运营法律实体和正式通知地址尚未获批，不得依据其他公司的公开网站或条款推断。</p><p>评估期间，请将问题发送给提供访问权限的部署负责人。本条款必须在任何商业上线前完成法律审核。</p></>,
  },
];

export default function TermsPage() {
  return <LegalPage title="使用条款" summary="用于评估本公开产品网站的预发布条件，以及网站咨询与另行签约的采购部署之间的边界。" effectiveDate="预发布" lastUpdated="2026 年 9 月 1 日" sections={sections} />;
}
