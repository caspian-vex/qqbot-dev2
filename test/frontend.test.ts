// 前端结构契约。
//
// 面板是无构建的手写 HTML 字符串（web/dist/app.js）+ 手写 CSS，没有模板引擎、
// 没有快照测试，所以「每张卡都有通栏标题栏」这种约束只能靠字符串级断言兜住。
// 一旦有人新加一张卡却忘了写 .card-head，页面不会报错，只会静默地少一条分隔线、
// 标题与正文左边缘错开、按钮回到正文里——正是这次重构要消灭的形态。
//
// 几何量（卡头 44px、按钮上下留白相等、左右对称）不做进单测：那需要真浏览器，
// 交给 .workbuddy-ai/preview/verify-cards.mjs 的 CDP 断言，单测只钉结构。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const web = join(__dirname, '..', 'web', 'dist');
const js = readFileSync(join(web, 'app.js'), 'utf8');
const css = readFileSync(join(web, 'style.css'), 'utf8');

const count = (s: string, re: RegExp): number => (s.match(re) || []).length;

test('每个 h3 都挂在 .card-head 里，卡片直接子级不再是裸 h3', () => {
  // 恰好相等而不是 >=：多一个 h3 说明有人又写了旧形态，少一个说明标题被删了，
  // 两种都该红。
  assert.equal(
    count(js, /class="card-head"/g),
    count(js, /<h3[ >]/g),
    'card-head 的数量必须等于 <h3> 的数量',
  );
  // 允许 <div class="card"> 与 <div class="card" id="…">，但要排除 card-head 本身
  assert.equal(
    count(js, /<div class="card(?![-\w])[^>]*>\s*<h3/g),
    0,
    '卡片的直接子级不能还是裸 h3',
  );
});

test('旧的卡片标题选择器已删干净', () => {
  // .card > h3 与 .pool-head 是重构前的两套卡头；留着它们就会出现
  // 「同一份样式两个来源」，改一处忘一处的典型症状。
  assert.doesNotMatch(css, /\.card\s*>\s*h3/);
  assert.doesNotMatch(css, /\.pool-head/);
  assert.doesNotMatch(js, /class="pool-head"/);
  assert.match(css, /\.card-head\s*\{/);
  assert.match(css, /\.card-actions\s*\{/);
});

test('控件高度走同一把尺', () => {
  // 回归点：给 input 留 8px 纵向 padding 会让它比按钮高 7px，而 .row 是
  // align-items:flex-end —— 底边对齐立刻错开 3~7px，"按钮和输入框不齐"就是这么来的。
  assert.match(css, /--ctl-h:\s*\d+px/);
  assert.match(css, /height:\s*var\(--ctl-h\)/);
  assert.doesNotMatch(
    css,
    /input\[type=text\][^{]*\{[^}]*padding:\s*8px 10px/,
    '单行输入框不能再用纵向 padding 撑高度',
  );
});

test('页头吸顶：滚到页面底部也能点到「保存设置」', () => {
  // 全局设置页有九张卡、两三千像素高，保存按钮本来只在页头。
  // 页头不吸顶，每次保存都要先把页面滚回顶部。
  const block = css.match(/\.page-head\s*\{([^}]*)\}/);
  assert.ok(block, '找不到 .page-head 规则');
  const body = block[1] ?? '';
  assert.match(body, /position:\s*sticky/);
  assert.match(body, /top:\s*0/);
  // 页头与第一张卡之间那段间距必须是 padding：margin 不参与背景绘制，
  // 卡片会从页头下方那条缝里滑过去，看着像页头飘在半空。
  assert.doesNotMatch(body, /margin-bottom/, '这段间距要走 padding，不能用 margin');
  assert.match(css, /\.page-head\.is-stuck/);
  // 吸顶状态由滚动同步：没有它，未滚动时也会画一条没有来由的分隔线。
  assert.match(js, /function syncStuckHead/);
  assert.match(js, /addEventListener\(\s*'scroll'/);
  // 横向也要铺满：页头在 .main 的内容盒里，只铺内容宽度的话，
  // 滚动时左右两侧各露出 30px 的卡片，像两条竖着的脏边。
  assert.match(css, /\.main\s*\{[^}]*--pad-x:\s*\d+px/, '.main 要把左右内边距暴露成 --pad-x');
  assert.match(body, /var\(--pad-x\)/, '.page-head 的横向留白与负边距要走 --pad-x');
  // 吸顶时切在卡片中间，线的颜色单独一档才看得见；两套主题都得有。
  assert.match(css, /--head-line:\s*#[0-9a-f]{6}/i);
  assert.equal((css.match(/--head-line:/g) || []).length, 2, '暗色与浅色各要定义一次');
});

test('吸附态的装饰不许凭空出现（滚到吸附那一刻会"抖一下"）', () => {
  // 回归点：0.3.2 把页头做成吸顶后，用户反馈"往下滑的时候顶部栏抖一下"。
  // 用 CDP 逐帧抓 screencast 截图量出来：布局位置一直是 0（getBoundingClientRect
  // 不抖），但吸附那一帧页头下沿凭空多出 1px 亮线 + 阴影 + 12px 渐隐，单帧内
  // 近三千个采样像素变色，下一帧又全静——就是这一下被看成"窜了一下"。
  // 所以：线和阴影在基础态先占位（颜色 transparent），渐隐层常驻（opacity 0），
  // is-stuck 只换颜色/透明度，120ms 过渡盖住那一帧的突变。
  const block = css.match(/\.page-head\s*\{([^}]*)\}/);
  const body = block?.[1] ?? '';
  assert.match(body, /box-shadow:\s*0 1px 0 transparent/, '分隔线要在基础态占位');
  assert.match(body, /transition:\s*box-shadow/, '线的出现要有过渡，不能硬切');
  assert.match(css, /\.page-head::after\s*\{[^}]*opacity:\s*0/, '渐隐层要常驻且默认不可见');
  assert.match(css, /\.page-head\.is-stuck::after\s*\{\s*opacity:\s*1/, '吸附时只改渐隐层的透明度');
  // 反过来钉住：不能再回到"只有 .page-head.is-stuck::after 才定义 content"
  assert.doesNotMatch(css, /\.page-head\.is-stuck::after\s*\{[^}]*content:/, '渐隐层不能只在吸附态创建');
});

test('被 JS 直接写 textContent 的 id 仍在能安全改写的元素上', () => {
  // #ps-ed-title / #ss-detail-title 是 h3 本身，被 textContent 赋值；
  // 一旦有人把按钮塞进这个 h3，赋值时按钮会被一起清掉（新建人格后保存按钮消失）。
  // #ac-totp-state / #ov-model 是 h3 里的 .hint，同理不能换成容器。
  assert.match(js, /<h3 id="ps-ed-title">/);
  assert.match(js, /<h3 id="ss-detail-title">/);
  assert.match(js, /<span class="hint" id="ac-totp-state">/);
  assert.match(js, /<span class="hint" id="ov-model"><\/span>/);
});
