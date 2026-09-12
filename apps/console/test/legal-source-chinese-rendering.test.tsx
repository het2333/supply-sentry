import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage, { metadata as privacyMetadata } from "../app/privacy/page.js";
import TermsPage, { metadata as termsMetadata } from "../app/terms/page.js";

const englishSystemCopy = [
  "Product navigation",
  "Request a Demo",
  "On this page",
  "Pre-release disclosure",
  "Privacy Policy",
  "Terms of Use",
  "About these terms",
  "Scope and current status",
  "Effective",
  "Last updated",
];

test("public legal pages render complete Chinese source UI without the runtime translator", () => {
  const terms = renderToStaticMarkup(createElement(TermsPage));
  const privacy = renderToStaticMarkup(createElement(PrivacyPage));

  for (const markup of [terms, privacy]) {
    assert.match(markup, /产品/);
    assert.match(markup, /工作原理/);
    assert.match(markup, /风险洞察/);
    assert.match(markup, /申请演示/);
    assert.match(markup, /本页内容/);
    assert.match(markup, /预发布声明/);
    assert.match(markup, /生效日期/);
    assert.match(markup, /最后更新/);
    for (const phrase of englishSystemCopy) assert.doesNotMatch(markup, new RegExp(phrase, "i"), phrase);
  }

  assert.match(terms, /使用条款/);
  assert.match(terms, /关于本条款/);
  assert.match(terms, /禁止的使用方式/);
  assert.match(terms, /人工监督与外部操作/);
  assert.match(privacy, /隐私政策/);
  assert.match(privacy, /适用范围与当前状态/);
  assert.match(privacy, /控制者与处理者角色/);
  assert.match(privacy, /数据保留、删除与权利/);
  assert.match(String(termsMetadata.title), /使用条款/);
  assert.match(String(termsMetadata.description), /预发布/);
  assert.match(String(privacyMetadata.title), /隐私政策/);
  assert.match(String(privacyMetadata.description), /预发布/);
});
