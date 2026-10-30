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

test('吸附态的装饰不许凭空出现，且必须与内容列对齐', () => {
  // 回归点：用户反馈"往下滑的时候顶部栏抖一下"。用 CDP 逐帧抓 screencast 截图
  // 量出来两件事：① 吸附那一帧页头下沿凭空多出 1px 亮线 + 阴影 + 12px 渐隐，
  // 单帧近三千个采样像素变色，下一帧又全静；② 页头自身在滚动头几帧从 top=14
  // 走到 0（见下一条用例）。这一条只管 ①：线和阴影在基础态先占位（颜色
  // transparent），渐隐层常驻（opacity 0），is-stuck 只换颜色/透明度，
  // 120ms 过渡盖住那一帧的突变。
  //
  // 还有一条对齐约束：页头的背景为了挡住从两侧滑过的卡片，比内容列左右各宽
  // --pad-x；线要是画在页头身上，两端就会在卡片之外各多出一小截悬着的尾巴
  // （实测左右各 26~30px），看着像没对齐。所以线与阴影挂在 ::before 上，
  // 左右各让进 --pad-x，正好落在卡片列的边框上。
  const block = css.match(/\.page-head\s*\{([^}]*)\}/);
  const body = block?.[1] ?? '';
  assert.doesNotMatch(body, /box-shadow/, '线与阴影不能画在页头自身：它会跟到页头的全宽背景上');
  const deco = css.match(/\.page-head::before\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(deco, /left:\s*var\(--pad-x\)/, '装饰层左边要与卡片列对齐');
  assert.match(deco, /right:\s*var\(--pad-x\)/, '装饰层右边要与卡片列对齐');
  assert.match(deco, /box-shadow:\s*0 1px 0 transparent/, '分隔线要在基础态占位');
  assert.match(deco, /transition:\s*box-shadow/, '线的出现要有过渡，不能硬切');
  assert.match(
    css,
    /\.page-head\.is-stuck::before\s*\{[^}]*box-shadow:\s*0 1px 0 var\(--head-line\)/,
    '吸附时只换线的颜色',
  );
  assert.match(css, /\.page-head::after\s*\{[^}]*opacity:\s*0/, '渐隐层要常驻且默认不可见');
  assert.match(css, /\.page-head\.is-stuck::after\s*\{\s*opacity:\s*1/, '吸附时只改渐隐层的透明度');
  // 反过来钉住：不能再回到"只有 .page-head.is-stuck::after 才定义 content"
  assert.doesNotMatch(css, /\.page-head\.is-stuck::after\s*\{[^}]*content:/, '渐隐层不能只在吸附态创建');
});

test('页头的上留白必须在页头里，不能在 .main 里（否则滚动时会窜一段）', () => {
  // 回归点：页头静态位置与吸顶位置(0)的差就是它的「自由行程」。
  // .main 的 padding-top + 页头的 margin-top 都是这段行程的来源：
  // 有行程，页头就跟着内容走几帧、然后在一帧内停住，相对内容整体错位一次；
  // 滚轮一格约 100px，这一停就是一帧内的事，看起来像"顶部栏窜了一下"。
  // 实测（改前）：页头 top 从 14 走到 0，夹取那帧内容走了 12px、页头只走 3px。
  // 所以：上留白归 .page-head 的 padding-top，.main 的 padding-top 必须为 0。
  const main = css.match(/\.main\s*\{([^}]*)\}/)?.[1] ?? '';
  const head = css.match(/\.page-head\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(main, /padding:\s*0\s+var\(--pad-x\)/, '.main 只留左右内边距，上留白交给页头');
  assert.doesNotMatch(main, /padding:\s*var\(--pad-y\)/, '上留白不许留在 .main（会长出自由行程）');
  assert.match(head, /padding:\s*var\(--pad-y\)\s+var\(--pad-x\)/, '页头的 padding-top 吃 --pad-y');
  assert.doesNotMatch(head, /margin:\s*-/, '页头不许再有纵向负边距');
  // 没有页头的视图（加载失败）要自己把那 26px 补回来
  assert.match(css, /\.main\s*>\s*\.err-inline\s*\{[^}]*margin-top/, '失败态要补回上留白');
  // 窄屏是可独立生效的覆盖块，必须一起改，只改桌面等于手机上还有一段行程
  const narrow = css.slice(css.indexOf('@media (max-width: 900px)'));
  assert.match(narrow, /\.main\s*\{[^}]*padding:\s*0\s+var\(--pad-x\)/, '窄屏 .main 也不能有上留白');
  assert.match(narrow, /\.page-head\s*\{[^}]*padding:\s*var\(--pad-y\)/, '窄屏页头要吃 --pad-y');
});

test('吸附判据同时看位置与滚动量', () => {
  // 上一条把页头的静态位置改成 0 之后，只看 rect.top 会永远为真（一进页面就画线），
  // 只看 scrollY 又会让窄屏（侧栏变成顶部横条、页头还在半空）提前画线。
  const body = js.match(/function syncStuckHead\(\)\s*\{([\s\S]*?)\n  \}/)?.[1] ?? '';
  assert.ok(body, '找不到 syncStuckHead 的实现');
  assert.match(body, /getBoundingClientRect\(\)\.top <= 0\.5/, '窄屏要靠位置判断真贴顶');
  assert.match(body, /window\.scrollY > 0/, '桌面要靠滚动量区分「还没滚」');
});

test('回声跟进的说明写清了「上一条在问问题时不会补」', () => {
  // 这句是用户唯一能看到「为什么有时候不补」的地方。后台悄悄把一个默认开启的
  // 能力调弱，界面上不写，看起来就像功能坏了。
  assert.match(js, /在等你回答/);
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

test('人格页的删除按「未启用且没人指定」放行，读的是列表里的 bindings', () => {
  // 删除人格有三道闸（仅剩一个 / 启用中 / 有会话在用），前端只做前两道里
  // 能提前判断的那些：把按钮禁掉并写明原因，而不是等用户点下去吃 400 再解释。
  assert.match(js, /api\('\/api\/personas\?id='/);
  assert.match(js, /const canDel = !p\.active && used === 0;/);
  assert.match(js, /p\.bindings/, '列表项要带上 bindings 计数，否则按钮无法判断');
});

test('机器人开关：登录页给入口，总览页给状态', () => {
  // 开关藏在「登录 QQ」页，但暂停状态必须在总览上看得见——总览是进来第一眼
  // 就会看的页面，不标的话关了两天会以为机器人坏了。
  assert.match(js, /data-act="bot-toggle"/);
  assert.match(js, /id="ov-bot"/);
  // 接口没返回这个字段时（旧版本、读设置失败）必须按"开"处理，
  // 否则面板会凭空显示一个并不存在的暂停状态。
  assert.match(js, /botEnabled = d\.enabled !== false;/);
});
