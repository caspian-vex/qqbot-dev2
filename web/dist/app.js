/* qqbot 控制台前端。
 *
 * 为什么是单文件、无构建、无框架：
 *   交付物承诺是「一条命令部署 + 一个可执行文件」。如果前端需要 npm install +
 *   vite build，部署链里就多出 Node 工具链和一次几分钟的构建，
 *   1 核 2G 的机器上这个代价不划算。面板本身是低频运维界面，
 *   六个页面、几十个控件，用原生 JS 完全够，而且改一行代码就能上线。
 *
 * 注意：服务端 CSP 是 script-src 'self'，所以这里不能写内联事件处理器
 * （onclick=...），全部通过 data-act + 事件委托完成。
 */
(() => {
  'use strict';

  const root = document.getElementById('root');

  /* ================= 基础工具 ================= */

  const $ = (sel, r = document) => r.querySelector(sel);
  const $$ = (sel, r = document) => Array.from(r.querySelectorAll(sel));

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('zh-CN'));
  const fmtCost = (n) => '¥' + Number(n || 0).toFixed(4);

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime()) || d.getFullYear() < 1970) return '—';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtClock(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '--:--:--';
    return d.toTimeString().slice(0, 8);
  }

  // 逗号/空白分隔的列表
  const parseList = (s) => String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  const parseNumList = (s) => parseList(s).map(Number).filter((n) => Number.isFinite(n) && n !== 0);

  /** 解析 hash 里的查询串。会话 ID 含冒号，链接里必须 encodeURIComponent。 */
  function hashQuery() {
    const h = location.hash.replace(/^#\/?/, '');
    const i = h.indexOf('?');
    return new URLSearchParams(i < 0 ? '' : h.slice(i + 1));
  }

  /* ================= 提示 ================= */

  function toast(msg, kind = '') {
    let host = $('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 260);
    }, 3200);
  }

  const ok = (m) => toast(m, 'ok');
  const bad = (m) => toast(m, 'err');

  // 把错误渲染进指定容器；容器已经因为切页而消失时静默忽略
  const errInto = (sel) => (e) => {
    const n = $(sel);
    if (n) n.innerHTML = `<div class="err-inline">${esc(e.message)}</div>`;
  };

  /* ================= 接口 ================= */

  const app = { user: null, totp: false };

  async function api(path, opts = {}) {
    const { method = 'GET', body, keepSession = false } = opts;
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = cookie('qqbot_csrf');

    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('网络错误：' + e.message);
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = null; }
    }

    if (!res.ok) {
      // 会话过期：直接回登录页，不要让用户对着一堆报错猜
      // keepSession：改密码/改用户名时密码输错也是 401，那种情况不该把人踢出去
      if (res.status === 401 && app.user && !keepSession) {
        app.user = null;
        renderLogin();
      }
      const err = new Error((data && data.error) || ('请求失败（HTTP ' + res.status + '）'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ================= 路由 ================= */

  let stops = [];

  function stopAll() {
    for (const fn of stops) {
      try { fn(); } catch (_) { /* 清理失败不影响切换页面 */ }
    }
    stops = [];
  }

  const ROUTES = {
    overview: { title: '总览', icon: '◉', view: viewOverview },
    qq:       { title: '登录', icon: '⌁', view: viewQQ },
    network:  { title: '网络', icon: '⇄', view: viewNetwork },
    napcat:   { title: '协议端', icon: '⌗', view: viewNapcat },
    // 叫「全局设置」而不是「设置」：会话列表每行也有一个「设置」，
    // 两个同名入口会让用户以为点哪个都一样，实际一个是全局、一个是单个会话。
    settings: { title: '全局设置', icon: '⚙', view: viewSettings },
    pool:     { title: '图池', icon: '❏', view: viewPool },
    personas: { title: '人格', icon: '✦', view: viewPersonas },
    sessions: { title: '会话', icon: '☰', view: viewSessions },
    // 会话设置要从列表带 id 进来，nav:false 让侧栏不出现这个入口——
    // 否则点进去就是「缺少会话 ID」，看着像坏掉的菜单项
    'session-settings': { title: '会话设置', icon: '⚙', view: viewSessionSettings, nav: false },
    usage:    { title: '用量', icon: '▤', view: viewUsage },
    account:  { title: '账号', icon: '⛨', view: viewAccount },
  };

  function route() {
    stopAll();
    const key = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    const name = ROUTES[key] ? key : 'overview';

    $$('.nav-item[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));

    const old = $('#view');
    if (!old) return;

    // 每次切换都换一个新的容器元素，而不是清空旧元素的内容。
    // 原因：视图里给容器挂了事件委托，直接复用元素会让上一页的监听器一直累积，
    // 既漏内存，也可能让旧页面的 handler 在新页面上误触发。
    const fresh = document.createElement('main');
    fresh.className = 'main';
    fresh.id = 'view';
    old.replaceWith(fresh);

    document.title = ROUTES[name].title + ' · qqbot';
    Promise.resolve(ROUTES[name].view(fresh)).catch((e) => {
      fresh.innerHTML = `<div class="err-inline">加载失败：${esc(e.message)}</div>`;
    });
  }

  /* ================= 事件委托 ================= */

  function bindActions(scope, handlers) {
    scope.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || !scope.contains(el)) return;
      const fn = handlers[el.dataset.act];
      if (!fn) return;
      e.preventDefault();
      fn(el, e);
    });
  }

  /* ================= 外观 ================= */

  // 'light' | 'dark' | 'system'，存 localStorage。
  // 首帧已经由 theme.js 处理过，这里负责切换、跟随系统与控件的选中态。
  const THEME_KEY = 'qqbot-theme';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

  function themeMode() {
    try {
      return localStorage.getItem(THEME_KEY) || 'dark';
    } catch (_) {
      return 'dark';
    }
  }

  function applyTheme() {
    const m = themeMode();
    document.documentElement.dataset.theme =
      m === 'system' ? (prefersDark.matches ? 'dark' : 'light') : m;
  }

  // 系统主题变化时只有「跟随系统」需要跟着变
  prefersDark.addEventListener('change', () => {
    if (themeMode() === 'system') applyTheme();
  });

  // theme.js 理论上已经设好了；这里再跑一次，保证它被缓存或加载失败时也不至于没主题
  applyTheme();

  function themePickHTML() {
    const m = themeMode();
    const item = (v, label) =>
      `<button data-act="theme" data-v="${v}" class="${m === v ? 'on' : ''}">${label}</button>`;
    return `<div class="theme-pick" role="group" aria-label="外观">${
      item('light', '浅色')}${item('dark', '暗色')}${item('system', '跟随系统')}</div>`;
  }

  function syncThemePick(v) {
    $$('.theme-pick button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  }

  // 挂在 document 上：登录页和外壳各有一套切换器，登录页没有 data-act 的公共父级
  bindActions(document, {
    theme: (el) => {
      try {
        localStorage.setItem(THEME_KEY, el.dataset.v);
      } catch (_) {
        /* 存不了就只在本次会话生效 */
      }
      applyTheme();
      syncThemePick(el.dataset.v);
    },
  });

  /* ================= 登录 ================= */

  function renderLogin() {
    stopAll();
    app.user = null;

    root.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <h1>qqbot 控制台</h1>
          <div class="sub">请输入管理员凭据</div>
          <div id="login-err"></div>
          <div class="field">
            <label>用户名</label>
            <input type="text" id="lg-user" autocomplete="username">
          </div>
          <div class="field">
            <label>密码</label>
            <input type="password" id="lg-pass" autocomplete="current-password">
          </div>
          <div class="field" id="lg-totp-wrap" style="display:none">
            <label>动态验证码</label>
            <input type="text" id="lg-totp" inputmode="numeric" autocomplete="one-time-code"
                   maxlength="6" placeholder="6 位数字">
          </div>
          <button class="btn" id="lg-submit" style="width:100%;margin-top:6px">登录</button>
          <div style="margin-top:14px;font-size:11.5px;color:var(--fg-mute);line-height:1.6">
            初始密码在首次启动时打印在服务日志里，只显示一次。<br>
            忘记密码：服务器上执行 <code>qqbot reset-password</code>。
          </div>
          ${themePickHTML()}
        </div>
      </div>`;

    const submit = async () => {
      const btn = $('#lg-submit');
      const errBox = $('#login-err');
      errBox.innerHTML = '';
      btn.disabled = true;
      try {
        await api('/api/auth/login', {
          method: 'POST',
          body: {
            username: $('#lg-user').value.trim(),
            password: $('#lg-pass').value,
            totp: $('#lg-totp').value.trim(),
          },
        });
        const st = await api('/api/auth/status');
        app.user = st.user;
        app.totp = !!st.totp_enabled;
        renderShell();
      } catch (e) {
        // 需要两步验证时把输入框露出来，省得用户不知道为什么登不上
        if (/验证码/.test(e.message)) $('#lg-totp-wrap').style.display = '';
        errBox.innerHTML = `<div class="err-inline">${esc(e.message)}</div>`;
      } finally {
        btn.disabled = false;
      }
    };

    $('#lg-submit').addEventListener('click', submit);
    // 监听器挂在卡片上而不是 document 上：卡片每次登录都会重建，
    // 监听器跟着元素一起消失，不会跨次累积。
    $('.login-card').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    // 用户名不预填：默认账号虽然叫 admin，但它可以在设置里改名，
    // 预填一个"看起来像答案"的 admin，改过名的人只会先撞一次登录失败。
    setTimeout(() => {
      const u = $('#lg-user');
      if (u && u.value === '') u.focus();
      else $('#lg-pass')?.focus();
    }, 30);
  }

  /* ================= 外壳 ================= */

  function renderShell() {
    root.innerHTML = `
      <div class="shell">
        <aside class="side">
          <div class="brand">qqbot<small>轻量 QQ 机器人</small></div>
          ${Object.entries(ROUTES).filter(([, r]) => r.nav !== false).map(([k, r]) =>
            `<a class="nav-item" data-nav="${k}" href="#/${k}"><span class="ico">${r.icon}</span>${r.title}</a>`
          ).join('')}
          <div class="side-foot">
            ${themePickHTML()}
            <div id="side-user" style="margin:8px 0 6px">${esc(app.user || '')}</div>
            <a href="#/" data-act="logout" style="color:var(--fg-dim)">退出登录</a>
          </div>
        </aside>
        <main class="main" id="view"></main>
      </div>`;

    bindActions(root, {
      logout: async () => {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) { /* 已经掉线也算登出 */ }
        renderLogin();
      },
    });

    if (!location.hash) location.hash = '#/overview';
    route();
  }

  window.addEventListener('hashchange', () => {
    if (app.user) route();
  });

  /* ================= 总览 ================= */

  function viewOverview(el) {
    el.innerHTML = `
      <div class="page-head">
        <div>
          <h2>总览</h2>
          <div class="desc">协议端连接、今日流量与实时日志</div>
        </div>
      </div>

      <div class="grid c4" style="margin-bottom:16px">
        <div class="metric">
          <div class="k">协议端</div>
          <div class="v sm"><span class="dot" id="ov-dot"></span><span id="ov-conn">—</span></div>
        </div>
        <div class="metric">
          <div class="k">机器人</div>
          <div class="v sm mono" id="ov-self">—</div>
        </div>
        <div class="metric">
          <div class="k">运行时长</div>
          <div class="v sm" id="ov-up">—</div>
        </div>
        <div class="metric">
          <div class="k">今日花费</div>
          <div class="v" id="ov-cost">—</div>
        </div>
      </div>

      <div class="card">
        <h3>消息与模型 <span class="hint" id="ov-model"></span></h3>
        <div class="grid c5">
          <div class="metric"><div class="k">收到</div><div class="v" id="ov-recv">0</div></div>
          <div class="metric"><div class="k">已回复</div><div class="v" id="ov-rep">0</div></div>
          <div class="metric"><div class="k">忽略</div><div class="v" id="ov-ign">0</div></div>
          <div class="metric"><div class="k">丢弃</div><div class="v" id="ov-drop">0</div></div>
          <div class="metric"><div class="k">错误</div><div class="v" id="ov-err">0</div></div>
        </div>
        <div class="hr"></div>
        <div class="grid c3">
          <div class="metric"><div class="k">今日模型请求</div><div class="v sm" id="ov-req">0</div></div>
          <div class="metric"><div class="k">输入 / 输出 token</div><div class="v sm mono" id="ov-tok">0 / 0</div></div>
          <div class="metric"><div class="k">高峰时段请求</div><div class="v sm" id="ov-peak">0</div></div>
        </div>
      </div>

      <div class="card">
        <h3>测试发送 <span class="hint">直接调用协议端发一条消息，不经过模型</span></h3>
        <div class="row">
          <div class="grow" style="flex:0 0 130px">
            <label class="field" style="margin:0"><span style="font-size:12px;color:var(--fg-dim)">类型</span></label>
            <select id="qs-type">
              <option value="group">群聊</option>
              <option value="private">私聊</option>
            </select>
          </div>
          <div class="grow">
            <label class="field" style="margin:0"><span style="font-size:12px;color:var(--fg-dim)">目标</span></label>
            <input type="text" id="qs-target" list="qs-targets" placeholder="群号或 QQ 号">
            <datalist id="qs-targets"></datalist>
          </div>
          <div class="grow" style="flex:2 1 280px">
            <label class="field" style="margin:0"><span style="font-size:12px;color:var(--fg-dim)">内容</span></label>
            <input type="text" id="qs-text" placeholder="要发送的文字">
          </div>
          <button class="btn" data-act="qs-send">发送</button>
        </div>
      </div>

      <div class="card">
        <h3>实时日志 <span class="hint">最近 500 条</span></h3>
        <div class="logbox" id="ov-log"></div>
      </div>`;

    // ---- 状态轮询 ----
    const refresh = async () => {
      let d;
      try { d = await api('/api/overview'); } catch (_) { return; }

      // 请求返回时用户可能已经切走了，元素不在了就别再碰
      const dot = $('#ov-dot');
      if (!dot) return;

      dot.className = 'dot ' + (d.connected ? (d.online ? 'ok' : 'warn') : 'bad');
      $('#ov-conn').textContent = d.connected ? (d.online ? '已连接' : '在线状态未知') : '未连接';
      $('#ov-self').textContent = d.self_id ? `${d.nickname || ''} (${d.self_id})` : '未登录';
      $('#ov-up').textContent = d.uptime || '—';
      $('#ov-cost').textContent = fmtCost(d.usage_today && d.usage_today.cost_cny);
      $('#ov-model').textContent = d.model ? '模型 ' + d.model : '';

      const s = d.stats || {};
      $('#ov-recv').textContent = fmtInt(s.received);
      $('#ov-rep').textContent = fmtInt(s.replied);
      $('#ov-ign').textContent = fmtInt(s.ignored);
      $('#ov-drop').textContent = fmtInt(s.dropped);
      $('#ov-err').textContent = fmtInt(s.errors);

      const u = d.usage_today || {};
      $('#ov-req').textContent = fmtInt(u.requests);
      $('#ov-tok').textContent = fmtInt(u.prompt_tokens) + ' / ' + fmtInt(u.completion_tokens);
      $('#ov-peak').textContent = fmtInt(u.peak_requests);

      if (d.last_error) $('#ov-conn').title = d.last_error;
    };

    refresh();
    const timer = setInterval(refresh, 2500);
    stops.push(() => clearInterval(timer));

    // ---- 目标候选 ----
    api('/api/groups').then((d) => {
      const dl = $('#qs-targets');
      if (!dl || !d) return;
      dl.innerHTML = (d.items || [])
        .map((g) => `<option value="${g.group_id}">${esc(g.group_name || '')}</option>`)
        .join('');
    }).catch(() => { /* 协议端没连上就只让手动输入 */ });

    bindActions(el, {
      'qs-send': async () => {
        const target = Number($('#qs-target').value.trim());
        const text = $('#qs-text').value.trim();
        if (!target) return bad('请填目标群号或 QQ 号');
        if (!text) return bad('消息内容不能为空');
        try {
          await api('/api/test/send', {
            method: 'POST',
            body: { target_type: $('#qs-type').value, target_id: target, text },
          });
          ok('已发送');
          $('#qs-text').value = '';
        } catch (e) { bad(e.message); }
      },
    });

    // ---- 日志流 ----
    const box = $('#ov-log');
    const append = (line) => {
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      const div = document.createElement('div');
      div.className = 'logline';
      const attrs = line.attrs
        ? ' ' + Object.entries(line.attrs).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' ')
        : '';
      div.innerHTML =
        `<span class="t">${esc(fmtClock(line.time))}</span>` +
        `<span class="lv ${esc(line.level || '')}">${esc(line.level || '')}</span>` +
        `<span class="m">${esc(line.msg || '')}<span class="a">${attrs}</span></span>`;
      box.appendChild(div);
      while (box.childElementCount > 500) box.removeChild(box.firstChild);
      if (nearBottom) box.scrollTop = box.scrollHeight;
    };

    const es = new EventSource('/api/logs');
    es.onmessage = (ev) => {
      try { append(JSON.parse(ev.data)); } catch (_) { /* 忽略坏帧 */ }
    };
    stops.push(() => es.close());
  }

  /* ================= 设置 ================= */

  function viewSettings(el) {
    el.innerHTML = `<div class="page-head"><div><h2>全局设置</h2>
      <div class="desc">模型接入与触发规则，对所有会话生效，保存后立即生效</div></div></div>
      <div id="set-body"><div class="empty">加载中…</div></div>`;

    Promise.all([
      api('/api/settings'),
      // 图池接口失败不挡设置页：目录还没建时按空池子处理
      api('/api/images').catch(() => ({ dir: '', items: [] })),
    ]).then(([s, pool]) => {
      if (!$('#set-body')) return; // 用户已经切走
      const imgDir = pool.dir || '';
      const l = s.llm, b = s.bot, c = s.context, p = s.proactive || {}, img = s.images || {},
            vis = s.vision || {}, sr = s.search || {};
      $('#set-body').innerHTML = `
        <div class="card">
          <h3>模型 <span class="hint">OpenAI 兼容接口，默认指向 DeepSeek</span></h3>
          <div class="grid c2">
            <div class="field">
              <label>接口地址</label>
              <input type="text" id="f-baseurl" value="${esc(l.base_url)}" placeholder="https://api.deepseek.com">
              <div class="note">填域名或带 /v1 都可以，客户端会自动补 /v1/chat/completions。</div>
            </div>
            <div class="field">
              <label>API Key</label>
              <input type="text" id="f-apikey" value="${esc(l.api_key)}" placeholder="sk-...">
              <div class="note">已加密存储；不动这个字段就不会覆盖原值。</div>
            </div>
            <div class="field">
              <label>模型名称</label>
              <input type="text" id="f-model" value="${esc(l.model)}">
            </div>
            <div class="field">
              <label>温度</label>
              <input type="number" id="f-temp" step="0.1" min="0" max="2" value="${l.temperature}">
            </div>
            <div class="field">
              <label>最大输出 token</label>
              <input type="number" id="f-maxtok" min="1" max="8192" value="${l.max_tokens}">
            </div>
            <div class="field">
              <label>超时（秒）</label>
              <input type="number" id="f-timeout" min="1" max="300" value="${l.timeout_sec}">
            </div>
          </div>
          <label class="check">
            <input type="checkbox" id="f-thinking" ${l.thinking ? 'checked' : ''}>
            <span>开启思考模式
              <span class="note">默认关闭。开启后每条消息先跑一段思维链，首字延迟从 1 秒级涨到 5 秒级，
              token 也翻几倍。聊天场景建议保持关闭；温度在思考模式下会被忽略。</span>
            </span>
          </label>
        </div>

        <div class="card">
          <h3>触发规则</h3>
          <div class="grid c2">
            <div class="field">
              <label>唤醒词</label>
              <input type="text" id="f-wake" value="${esc((b.wake_words || []).join('，'))}"
                     placeholder="多个用逗号分隔">
              <div class="note">消息以唤醒词开头即触发，唤醒词会从正文里剥掉。留空则只响应 @ 与私聊。</div>
            </div>
            <div class="field">
              <label>被动接话概率</label>
              <input type="number" id="f-passive" step="0.05" min="0" max="1" value="${b.passive_rate}">
              <div class="note">0 表示只在被 @ 或命中唤醒词时回复；0.15 表示普通消息有 15% 概率接话。</div>
            </div>
            <div class="field">
              <label>群冷却（秒）</label>
              <input type="number" id="f-gcd" min="0" max="3600" value="${b.group_cooldown_sec}">
              <div class="note">被动接话的最小间隔，防止在热闹的群里刷屏。</div>
            </div>
            <div class="field">
              <label>最大并发会话</label>
              <input type="number" id="f-conc" min="1" max="10" value="${b.max_concurrent}">
              <div class="note">同一会话永远串行；这个值限制的是不同会话之间的并发。</div>
            </div>
            <div class="field">
              <label>最多分几段</label>
              <input type="number" id="f-segs" min="1" max="8" value="${b.max_segments}">
              <div class="note">长回复按句切开分条发送，更像真人打字；超过上限会合并截断。</div>
            </div>
            <div class="field">
              <label>群白名单</label>
              <input type="text" id="f-wlg" value="${esc((b.whitelist_groups || []).join('，'))}"
                     placeholder="留空表示所有群">
              <div class="note">非空时只处理这些群，其它群完全静默。</div>
            </div>
            <div class="field">
              <label>用户黑名单</label>
              <input type="text" id="f-blu" value="${esc((b.blacklist_users || []).join('，'))}"
                     placeholder="留空表示不屏蔽任何人">
            </div>
          </div>
        </div>

        <div class="card">
          <h3>主动发言 <span class="hint">回复后隔一小会儿主动补一句相关的话</span></h3>
          <label class="check">
            <input type="checkbox" id="f-echo" ${(p.echo_enabled ? 'checked' : '')}>
            <span>开启回声式跟进
              <span class="note">回复完用户后，按概率延迟补一句相关的话或小问题。
              对方有任何新消息都会立即取消未发出的跟进；连续不接话会自然停住。</span>
            </span>
          </label>
          <div class="grid c2">
            <div class="field">
              <label>触发概率</label>
              <input type="number" id="f-echo-rate" step="0.05" min="0" max="1" value="${p.echo_rate ?? 0.35}">
              <div class="note">每次回复后有多大概率安排跟进，0.35 表示三次里约有一次。</div>
            </div>
            <div class="field">
              <label>延迟范围（秒）</label>
              <div class="row" style="gap:8px">
                <input type="number" id="f-echo-min" min="5" max="3600" value="${p.echo_min_sec ?? 30}" aria-label="延迟下限">
                <span>至</span>
                <input type="number" id="f-echo-max" min="5" max="3600" value="${p.echo_max_sec ?? 90}" aria-label="延迟上限">
              </div>
              <div class="note">实际延迟在范围内随机取值；秒级整点或固定间隔一眼就是机器。</div>
            </div>
            <div class="field">
              <label>同一会话冷却（分钟）</label>
              <input type="number" id="f-echo-cd" min="0" max="1440" value="${p.echo_cooldown_min ?? 30}">
              <div class="note">两次跟进的最小间隔，防止对一个话题穷追不舍。</div>
            </div>
            <div class="field">
              <label>每日上限（条）</label>
              <input type="number" id="f-echo-limit" min="0" max="100" value="${p.echo_daily_limit ?? 5}">
              <div class="note">只算本会话，各会话互不占用额度；进程另有 100 条/天的硬顶兜底。</div>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>图池 <span class="hint">按标签分类的图片库，在「<a href="#/pool">图池</a>」页维护</span></h3>
          <label class="check">
            <input type="checkbox" id="f-img" ${(img.enabled ? 'checked' : '')}>
            <span>允许机器人发图
              <span class="note">开启后图池的「标签 + 备注」会注入系统提示，模型判断此刻适合哪一类就发哪一类。
              它有权不发；图池为空时这个开关没有效果。</span>
            </span>
          </label>
          <div class="grid c2">
            <div class="field">
              <label>单条回复最多发几张</label>
              <input type="number" id="f-img-max" min="1" max="3" value="${img.max_per_reply ?? 1}">
              <div class="note">模型点了更多图也只发前几张；1 张最稳妥。</div>
            </div>
            <div class="field">
              <label>图池目录</label>
              <input type="text" id="f-img-dir" value="${esc(imgDir)}" readonly>
              <div class="note">一个标签一个子目录；也可以直接往这里拷图，算作「未分类」。</div>
            </div>
          </div>
          <div class="field">
            <label>标签概览</label>
            <div id="f-imglist" class="note">加载中…</div>
          </div>
        </div>

        <div class="card">
          <h3>图片识别 <span class="hint">用户发来的图直接交给模型看</span></h3>
          <label class="check">
            <input type="checkbox" id="f-vision" ${(vis.enabled !== false ? 'checked' : '')}>
            <span>识别用户发来的图片
              <span class="note">开启后，@ 或私聊里的图片会下载下来随消息一起发给模型，
              需要模型支持图片输入（默认的 deepseek-flash 支持）。下载失败、单张超过 5MB、单条合计超过 8MB
              或不是真图片的会被跳过，这条消息按纯文字处理，不会因此不回复。用的是纯文字模型就把它关掉。</span>
            </span>
          </label>
          <div class="grid c2">
            <div class="field">
              <label>单条消息最多看几张</label>
              <input type="number" id="f-vision-max" min="1" max="4" value="${vis.max_images ?? 4}">
              <div class="note">每张图都要花 token；表情包刷屏时这个上限就是成本的闸。多出来的图不会下载。</div>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>联网搜索 <span class="hint">模型拿不准时自己去查一下</span></h3>
          <label class="check">
            <input type="checkbox" id="f-search" ${(sr.enabled ? 'checked' : '')}>
            <span>允许模型联网搜索
              <span class="note">开启后把 web_search 作为工具交给模型，由它判断这句话要不要查：
              新闻、价格、比分、天气、最近发生的事会去查，闲聊不会。查的是 DeepSeek 官方搜索，
              与上面的模型共用同一把 API Key，不用再配搜索源；按成功请求计费（约 ¥5 / 千次，无结果不计费）。
              需要模型支持工具调用（function calling），不支持时会自动退回普通对话，不影响回复。</span>
            </span>
          </label>
          <div class="grid c2">
            <div class="field">
              <label>每次取几条结果</label>
              <input type="number" id="f-search-results" min="1" max="10" value="${sr.max_results ?? 5}">
              <div class="note">取多了会把上下文预算挤满，3-5 条通常够用。</div>
            </div>
            <div class="field">
              <label>每条消息最多搜几次</label>
              <input type="number" id="f-search-calls" min="1" max="3" value="${sr.max_calls ?? 2}">
              <div class="note">成本硬闸：每多一次就是一次模型请求加一次搜索请求。</div>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>上下文</h3>
          <div class="grid c2">
            <div class="field">
              <label>保留轮数</label>
              <input type="number" id="f-turns" min="0" max="50" value="${c.max_turns}">
              <div class="note">一轮 = 用户一句 + 助手一句。0 表示不带历史。</div>
            </div>
            <div class="field">
              <label>token 预算</label>
              <input type="number" id="f-budget" min="200" max="100000" value="${c.token_budget}">
              <div class="note">历史按此预算从新到旧裁剪，超出的整轮丢弃，保证问答成对。</div>
            </div>
          </div>
        </div>

        <div class="row end">
          <button class="btn" data-act="save">保存设置</button>
        </div>`;

      bindActions(el, {
        save: async (btn) => {
          btn.disabled = true;
          try {
            await api('/api/settings', {
              method: 'PUT',
              body: {
                llm: {
                  base_url: $('#f-baseurl').value.trim(),
                  api_key: $('#f-apikey').value.trim(),
                  model: $('#f-model').value.trim(),
                  temperature: Number($('#f-temp').value),
                  max_tokens: Number($('#f-maxtok').value),
                  thinking: $('#f-thinking').checked,
                  timeout_sec: Number($('#f-timeout').value),
                },
                bot: {
                  wake_words: parseList($('#f-wake').value),
                  passive_rate: Number($('#f-passive').value),
                  group_cooldown_sec: Number($('#f-gcd').value),
                  max_concurrent: Number($('#f-conc').value),
                  max_segments: Number($('#f-segs').value),
                  seg_delay_min_ms: b.seg_delay_min_ms,
                  seg_delay_max_ms: b.seg_delay_max_ms,
                  whitelist_groups: parseNumList($('#f-wlg').value),
                  blacklist_users: parseNumList($('#f-blu').value),
                  quote_reply: b.quote_reply,
                },
                context: {
                  max_turns: Number($('#f-turns').value),
                  token_budget: Number($('#f-budget').value),
                },
                proactive: {
                  echo_enabled: $('#f-echo').checked,
                  echo_rate: Number($('#f-echo-rate').value),
                  echo_min_sec: Number($('#f-echo-min').value),
                  echo_max_sec: Number($('#f-echo-max').value),
                  echo_cooldown_min: Number($('#f-echo-cd').value),
                  echo_daily_limit: Number($('#f-echo-limit').value),
                },
                images: {
                  enabled: $('#f-img').checked,
                  max_per_reply: Number($('#f-img-max').value),
                },
                vision: {
                  enabled: $('#f-vision').checked,
                  max_images: Number($('#f-vision-max').value),
                },
                search: {
                  enabled: $('#f-search').checked,
                  max_results: Number($('#f-search-results').value),
                  // 超时不放到界面上：8 秒已经比用户耐心长，调它多半是自找麻烦
                  timeout_sec: sr.timeout_sec ?? 8,
                  max_calls: Number($('#f-search-calls').value),
                },
              },
            });
            ok('设置已保存');
          } catch (e) {
            bad(e.message);
          } finally {
            btn.disabled = false;
          }
        },
      });

      // 标签概览（真正的增删改在「图池」页）
      const tags = pool.tags || [];
      const listBox = $('#f-imglist');
      if (listBox) {
        listBox.innerHTML = tags.length === 0
          ? '（空）——去 <a href="#/pool">图池</a> 新建一个标签并上传图片，机器人就有图可发了'
          : tags.map((t) => `${esc(t.name)}（${t.count} 张）`).join('、') +
            ` · 共 ${pool.total || 0} 张 · <a href="#/pool">去图池管理</a>`;
      }
    }).catch(errInto('#set-body'));
  }

  /* ================= 会话设置（按对话对象覆盖） ================= */

  // 与服务端 OVERRIDABLE_GROUPS 一一对应，顺序即卡片顺序。
  // 模型与面板凭据不在这里：它们是部署级的，按会话复制会变成 N 份密文。
  const OVR_GROUPS = ['bot', 'proactive', 'images', 'vision', 'search', 'context'];
  const OVR_META = {
    bot: { title: '触发规则', hint: '唤醒词、接话概率、冷却、分段' },
    proactive: { title: '主动发言', hint: '回复后隔一会儿补一句' },
    images: { title: '图池', hint: '要不要发图、发几张' },
    vision: { title: '图片识别', hint: '用户发的图要不要看' },
    search: { title: '联网搜索', hint: '拿不准时自己去查' },
    context: { title: '上下文', hint: '带几轮历史、多少预算' },
  };

  const ovrNum = (id, label, val, min, max, note, step) => `
    <div class="field">
      <label>${label}</label>
      <input type="number" id="${id}"${step ? ` step="${step}"` : ''} min="${min}" max="${max}" value="${val}">
      ${note ? `<div class="note">${note}</div>` : ''}
    </div>`;

  const ovrCheck = (id, label, on, note) => `
    <label class="check">
      <input type="checkbox" id="${id}"${on ? ' checked' : ''}>
      <span>${label}${note ? `<span class="note">${note}</span>` : ''}</span>
    </label>`;

  function ovrBotBody(v, g) {
    const globalBlack = (g.blacklist_users || []).join('，');
    return `
      <div class="grid c2">
        <div class="field">
          <label>唤醒词</label>
          <input type="text" id="f-wake" value="${esc((v.wake_words || []).join('，'))}"
                 placeholder="多个用逗号分隔">
          <div class="note">留空表示只响应 @ 与私聊。</div>
        </div>
        ${ovrNum('f-passive', '被动接话概率', v.passive_rate, 0, 1, '0 表示只在被 @ 或命中唤醒词时回复。', '0.05')}
        ${ovrNum('f-gcd', '群冷却（秒）', v.group_cooldown_sec, 0, 3600, '被动接话的最小间隔，防止在热闹的群里刷屏。')}
        ${ovrNum('f-segs', '最多分几段', v.max_segments, 1, 8, '长回复按句切开分条发送。')}
        <div class="field">
          <label>最大并发会话（全局）</label>
          <input type="text" value="${esc(g.max_concurrent)}" readonly>
          <div class="note">队列级参数，所有会话共享，不按会话设。</div>
        </div>
        <div class="field">
          <label>群白名单（全局）</label>
          <input type="text" value="${esc((g.whitelist_groups || []).join('，') || '（不限）')}" readonly>
          <div class="note">部署级总闸，会话只能收紧、不能放宽。</div>
        </div>
      </div>
      <div class="field">
        <label>追加用户黑名单</label>
        <input type="text" id="f-blu" value="${esc((v.blacklist_users || []).join('，'))}"
               placeholder="只在本会话额外的屏蔽">
        <div class="note">全局黑名单（${esc(globalBlack || '空')}）里的人在所有会话都不回复；
        这里填的只会追加，删不掉全局那几个——要放宽只能去 <a href="#/settings">设置</a> 页删。</div>
      </div>`;
  }

  function ovrProactiveBody(v) {
    return `
      ${ovrCheck('f-echo', '开启回声式跟进', v.echo_enabled, '回复完按概率延迟补一句；对方一开口就取消。')}
      <div class="grid c2">
        ${ovrNum('f-echo-rate', '触发概率', v.echo_rate, 0, 1, '0.35 表示三次里约有一次。', '0.05')}
        <div class="field">
          <label>延迟范围（秒）</label>
          <div class="row" style="gap:8px">
            <input type="number" id="f-echo-min" min="5" max="3600" value="${v.echo_min_sec}" aria-label="延迟下限">
            <span>至</span>
            <input type="number" id="f-echo-max" min="5" max="3600" value="${v.echo_max_sec}" aria-label="延迟上限">
          </div>
          <div class="note">实际延迟在范围内随机取值。</div>
        </div>
        ${ovrNum('f-echo-cd', '本会话冷却（分钟）', v.echo_cooldown_min, 0, 1440, '两次跟进的最小间隔。')}
        ${ovrNum('f-echo-limit', '每日上限（条）', v.echo_daily_limit, 0, 100, '只算本会话，各会话互不占用额度。')}
      </div>`;
  }

  /** 每组卡片：标题右侧一个「本会话单独设置」开关，关着时整块置灰。 */
  function ovrCard(g, body, st) {
    const m = OVR_META[g];
    return `
      <div class="card">
        <h3>${m.title} <span class="hint">${m.hint}</span>
          <label class="check ovr-sw">
            <input type="checkbox" class="ovr" data-g="${g}"${st[g].on ? ' checked' : ''}>
            <span>本会话单独设置</span>
          </label>
        </h3>
        <fieldset class="ovr-body" id="g-${g}"${st[g].on ? '' : ' disabled'}>${body}</fieldset>
      </div>`;
  }

  /** 从界面读出某一组的完整值。 */
  function readOvrGroup(g, st) {
    const v = st[g].val || {};
    const num = (sel) => Number($(sel).value);
    if (g === 'bot') {
      return {
        wake_words: parseList($('#f-wake').value),
        passive_rate: num('#f-passive'),
        group_cooldown_sec: num('#f-gcd'),
        max_segments: num('#f-segs'),
        // 界面上不暴露的两个字段按原值回传。服务端也会用全局补全，
        // 但显式带上比"让服务端猜"更接近用户在设置页看到的那套值。
        seg_delay_min_ms: v.seg_delay_min_ms,
        seg_delay_max_ms: v.seg_delay_max_ms,
        quote_reply: v.quote_reply,
        blacklist_users: parseNumList($('#f-blu').value),
      };
    }
    if (g === 'proactive') {
      return {
        echo_enabled: $('#f-echo').checked,
        echo_rate: num('#f-echo-rate'),
        echo_min_sec: num('#f-echo-min'),
        echo_max_sec: num('#f-echo-max'),
        echo_cooldown_min: num('#f-echo-cd'),
        echo_daily_limit: num('#f-echo-limit'),
      };
    }
    if (g === 'images') {
      return { enabled: $('#f-img').checked, max_per_reply: num('#f-img-max') };
    }
    if (g === 'vision') {
      return { enabled: $('#f-vision').checked, max_images: num('#f-vision-max') };
    }
    if (g === 'search') {
      return {
        enabled: $('#f-search').checked,
        max_results: num('#f-search-results'),
        // 超时不放到界面上：8 秒已经比用户耐心长，调它多半是自找麻烦
        timeout_sec: v.timeout_sec,
        max_calls: num('#f-search-calls'),
      };
    }
    return { max_turns: num('#f-turns'), token_budget: num('#f-budget') };
  }

  function viewSessionSettings(el) {
    const id = (hashQuery().get('id') || '').trim();
    if (!id) {
      el.innerHTML = `<div class="page-head"><div><h2>会话设置</h2></div></div>
        <div class="err-inline">缺少会话 ID，请从「会话」列表那一行点「设置」进入</div>`;
      return;
    }

    // 保存/恢复按钮挂在页头右侧而不是卡片末尾：六张卡片铺下来，
    // 滚到底才能存，改完上面那几组再滚回来对一眼都费劲。
    el.innerHTML = `<div class="page-head">
        <div><h2>会话设置</h2><div class="desc" id="ss-head">加载中…</div></div>
        <div class="row" id="ss-acts"><a class="btn ghost" href="#/sessions">返回会话列表</a></div>
      </div>
      <div id="ss-body"><div class="empty">加载中…</div></div>`;

    Promise.all([
      api('/api/sessions/settings?id=' + encodeURIComponent(id)),
      // 人格清单：这个页面上也要能改人格，不能只回一个 id 没选项。
      // 拉不到就退化成"只有跟随默认"——六组设置照样能改，不为此挡住整页。
      api('/api/personas').catch(() => ({ items: [] })),
    ]).then(([d, dp]) => {
      if (!$('#ss-body')) return; // 用户已经切走
      const personas = dp.items || [];

      const ov = d.overrides || {};
      const gl = d.global || {};
      // 每组一份状态：on 只看 overrides 里有没有这一组（唯一真相），
      // val 是"勾上时预填的值"——已覆盖用覆盖值，否则用全局值。
      const st = {};
      for (const g of OVR_GROUPS) st[g] = { on: !!ov[g], val: ov[g] || gl[g] || {} };

      const head = $('#ss-head');
      if (head) {
        head.innerHTML = `${d.name ? `<b>${esc(d.name)}</b> ` : ''}<span class="mono">${esc(id)}</span>`;
      }

      const botVal = st.bot.val;
      const proVal = st.proactive.val;
      const imgVal = st.images.val;
      const visVal = st.vision.val;
      const srVal = st.search.val;
      const ctxVal = st.context.val;

      // 人格不是"覆盖"，天然就是按会话的，所以它没有「本会话单独设置」开关
      // ——打开这个页面的前提就是"只改这一个对象"，再套一层开关没有意义。
      const def = d.default_persona || { id: 0, name: '' };
      const pOn = (v) => (Number(d.persona_id) === Number(v) ? ' selected' : '');
      // 当前默认人格不进候选：它已经由「跟随默认」表达了，重复一项只会让人
      // 选错——而"显式绑到默认人格"是个陷阱：将来全局默认换人，这个会话
      // 还锁在旧人格上，界面上却看不出自己已经从"跟随"变成了"锁定"。
      const pOpts = [
        `<option value="0"${pOn(0)}>跟随默认${def.name ? `（${esc(def.name)}）` : ''}</option>`,
        ...personas
          .filter((x) => Number(x.id) !== Number(def.id))
          .map((x) => `<option value="${x.id}"${pOn(x.id)}>${esc(x.name)}</option>`),
      ].join('');

      $('#ss-body').innerHTML =
        `<div class="card">
          <h3>人格 <span class="hint">这个对话对象用哪套提示词</span></h3>
          <div class="grid c2">
            <div class="field">
              <label>使用的人格</label>
              <select id="ss-persona" aria-label="该会话使用的人格">${pOpts}</select>
              <div class="note">改完即时生效，不用点右上角的保存。选「跟随默认」就回到全局启用的那个人格。</div>
            </div>
          </div>
        </div>` +
        ovrCard('bot', ovrBotBody(botVal, gl.bot || {}), st) +
        ovrCard('proactive', ovrProactiveBody(proVal), st) +
        ovrCard('images', `
          ${ovrCheck('f-img', '允许机器人发图', imgVal.enabled)}
          <div class="grid c2">
            ${ovrNum('f-img-max', '单条回复最多发几张', imgVal.max_per_reply, 1, 3, '模型点了更多图也只发前几张。')}
          </div>`, st) +
        ovrCard('vision', `
          ${ovrCheck('f-vision', '识别用户发来的图片', visVal.enabled !== false,
            '关掉后图片段被忽略，这条消息按纯文字处理，不影响回复。')}
          <div class="grid c2">
            ${ovrNum('f-vision-max', '单条消息最多看几张', visVal.max_images, 1, 4, '每张图都花 token，这是成本的闸。')}
          </div>`, st) +
        ovrCard('search', `
          ${ovrCheck('f-search', '允许模型联网搜索', srVal.enabled,
            '与模型共用同一把 API Key，按成功请求计费（约 ¥5 / 千次）。')}
          <div class="grid c2">
            ${ovrNum('f-search-results', '每次取几条结果', srVal.max_results, 1, 10, '取多了会挤占上下文预算，3-5 条通常够用。')}
            ${ovrNum('f-search-calls', '每条消息最多搜几次', srVal.max_calls, 1, 3, '成本硬闸：每多一次就是一次模型请求加一次搜索请求。')}
          </div>`, st) +
        ovrCard('context', `
          <div class="grid c2">
            ${ovrNum('f-turns', '保留轮数', ctxVal.max_turns, 0, 50, '一轮 = 用户一句 + 助手一句。0 表示不带历史。')}
            ${ovrNum('f-budget', 'token 预算', ctxVal.token_budget, 200, 100000, '历史按此预算从新到旧裁剪，超出的整轮丢弃。')}
          </div>`, st);

      // 按钮等数据到位才出现：加载中就能点的"保存"，点下去只会报 id 未定义。
      const acts = $('#ss-acts');
      if (acts) {
        acts.insertAdjacentHTML('beforeend',
          `<button class="btn ghost" data-act="ovr-reset">恢复跟随全局</button>
           <button class="btn" data-act="ovr-save">保存本会话设置</button>`);
      }

      bindActions(el, {
        'ovr-save': async (btn) => {
          btn.disabled = true;
          try {
            const overrides = {};
            // 没勾的组根本不出现在 payload 里 —— 那就是"回落跟随全局"。
            // 服务端把空对象当成删行，所以关掉某组不需要另一个接口。
            for (const g of OVR_GROUPS) if (st[g].on) overrides[g] = readOvrGroup(g, st);
            await api('/api/sessions/settings', {
              method: 'PUT',
              body: { id, name: d.name || '', overrides },
            });
            ok('已保存');
            // 重新拉一次：服务端会把缺的字段用全局补全，界面要显示补全后的值
            route();
          } catch (e) {
            bad(e.message);
            btn.disabled = false;
          }
        },
        'ovr-reset': async (btn) => {
          if (!confirm('这个会话的独立设置会全部清空，人格也回到跟随默认。确定？')) return;
          btn.disabled = true;
          try {
            await api('/api/sessions/settings', {
              method: 'PUT',
              body: { id, name: d.name || '', overrides: {} },
            });
            // 人格一并解绑：按钮叫「恢复跟随全局」，只清六组却把人留在原地，
            // 用户会以为没恢复干净，还得自己再去上面改一次下拉。
            if (Number(d.persona_id) > 0) {
              await api('/api/sessions/persona', {
                method: 'POST',
                body: { id, persona_id: 0, name: d.name || '' },
              });
            }
            ok('已恢复跟随全局');
            route();
          } catch (e) {
            bad(e.message);
            btn.disabled = false;
          }
        },
      });

      // 人格走独立接口（不属于那六组覆盖），改完立即提交——与原来在会话列表
      // 改下拉是同一个行为，用户不必再点一次「保存本会话设置」。
      const psel = $('#ss-persona');
      if (psel) {
        psel.addEventListener('change', async () => {
          const pid = Number(psel.value);
          psel.disabled = true;
          try {
            await api('/api/sessions/persona', {
              method: 'POST',
              body: { id, persona_id: pid, name: d.name || '' },
            });
            d.persona_id = pid;
            ok(pid === 0 ? '已改为跟随默认人格' : '已为该会话指定人格');
          } catch (e) {
            bad(e.message);
            // 拨回真实状态：不回拉整页，省一次请求也不会丢用户勾好的六组开关
            psel.value = String(Number(d.persona_id) || 0);
          } finally {
            psel.disabled = false;
          }
        });
      }

      // 勾选只切 disabled，不清值：再勾上还是刚才那套数，
      // 从全局重新复制会把用户手改到一半的调整凭空抹掉。
      $$('input.ovr', el).forEach((cb) => {
        cb.addEventListener('change', () => {
          const g = cb.dataset.g;
          if (!st[g]) return;
          st[g].on = cb.checked;
          const box = $('#g-' + g);
          if (box) box.disabled = !cb.checked;
        });
      });
    }).catch(errInto('#ss-body'));
  }

  /* ================= 图池 ================= */

  const fmtKB = (n) => Math.max(1, Math.round((n || 0) / 1024)) + ' KB';
  const imgRaw = (tag, name) =>
    '/api/images/raw?tag=' + encodeURIComponent(tag) + '&name=' + encodeURIComponent(name);

  // 上传不能用 api()：那个会把 body 序列化成 JSON，这里要发文件本身。
  // 文件名走查询串、类型靠服务端嗅探文件头，前端只负责把字节送到。
  async function uploadImage(tag, file) {
    const q = '?tag=' + encodeURIComponent(tag) + '&name=' + encodeURIComponent(file.name || '');
    let res;
    try {
      res = await fetch('/api/images/upload' + q, {
        method: 'POST',
        headers: {
          'X-CSRF-Token': cookie('qqbot_csrf'),
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
        credentials: 'same-origin',
      });
    } catch (e) {
      throw new Error('网络错误：' + e.message);
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (_) { data = null; } }
    if (!res.ok) {
      if (res.status === 401) { app.user = null; renderLogin(); }
      throw new Error((data && data.error) || ('上传失败（HTTP ' + res.status + '）'));
    }
    return data;
  }

  function viewPool(el) {
    el.innerHTML = `
      <div class="page-head">
        <div>
          <h2>图池</h2>
          <div class="desc">按标签分类的图片库。标签的备注会写进系统提示，机器人据此判断此刻该发哪一类图</div>
        </div>
        <button class="btn" data-act="new-tag">新建标签</button>
      </div>

      <div class="card">
        <h3>怎么用 <span class="hint">标签 = 一个子目录，备注 = 给模型看的说明</span></h3>
        <div class="note">
          建一个标签（例如 <code>funny</code>），备注写清"好笑的梗图，群里出现好笑的事时发"，
          再往里传几张图。之后机器人聊到好笑的场面，就会自己挑一张 funny 里的图发出来。<br>
          模型侧的写法是 <code>[图:funny]</code>（随机一张）或 <code>[图:funny/文件名]</code>（指定一张），
          越界的名字一律丢弃，不会把奇怪的路径发出去。
        </div>
      </div>

      <div class="card" id="pool-new" style="display:none">
        <h3>新建标签</h3>
        <div class="row">
          <div class="grow" style="flex:0 0 180px">
            <label class="field" style="margin:0"><span style="font-size:12px;color:var(--fg-dim)">标签名</span></label>
            <input type="text" id="pool-new-name" maxlength="24" placeholder="funny">
          </div>
          <div class="grow" style="flex:1 1 320px">
            <label class="field" style="margin:0"><span style="font-size:12px;color:var(--fg-dim)">备注（给机器人看）</span></label>
            <input type="text" id="pool-new-note" maxlength="300" placeholder="好笑的梗图，群里出现好笑的事时发">
          </div>
          <button class="btn" data-act="create-tag">创建</button>
          <button class="btn ghost" data-act="cancel-new">取消</button>
        </div>
        <div class="note">标签名可用中文、字母、数字、下划线、连字符；备注随时能改。</div>
      </div>

      <div id="pool-body"><div class="empty">加载中…</div></div>`;

    let pool = { dir: '', tags: [], total: 0 };

    const thumbHTML = (t) => t.images.map((im) => `
      <figure class="pool-thumb">
        <img src="${esc(imgRaw(t.name, im.name))}" alt="${esc(im.name)}" loading="lazy">
        <figcaption>
          <span class="nm" title="${esc(im.name)} · ${fmtKB(im.size)}">${esc(im.name)}</span>
          <button class="x" data-act="del-img" data-tag="${esc(t.name)}" data-name="${esc(im.name)}"
                  title="删除这张">×</button>
        </figcaption>
      </figure>`).join('');

    const tagHTML = (t) => {
      const untagged = t.name === '未分类';
      return `
      <div class="card pool-tag">
        <div class="pool-head">
          <div class="grow">
            <h3>${esc(t.name)} <span class="hint">${t.images.length} 张</span></h3>
          </div>
          <div class="row" style="gap:6px;flex:0 0 auto">
            <button class="btn sm ghost" data-act="pick" data-tag="${esc(t.name)}">上传图片</button>
            ${untagged ? '' : `<button class="btn sm ghost" data-act="rename" data-tag="${esc(t.name)}">改名</button>
            <button class="btn sm danger" data-act="del-tag" data-tag="${esc(t.name)}">删除标签</button>`}
          </div>
        </div>

        <div class="field">
          <label>备注 <span class="hint">${t.note
            ? '写清这一类图是什么、什么场景适合发'
            : '还没写——机器人只看得到标签名，判断会差一些'}</span></label>
          <textarea rows="2" maxlength="300" data-note
            placeholder="例如：好笑的梗图与沙雕表情包，群里出现好笑的事、被调侃时发">${esc(t.note || '')}</textarea>
          <div class="row end" style="margin-top:8px">
            <button class="btn sm" data-act="save-note" data-tag="${esc(t.name)}">保存备注</button>
          </div>
        </div>

        <div class="drop" data-drop="${esc(t.name)}">
          <input type="file" accept="image/*" multiple hidden data-file>
          ${t.images.length ? `<div class="pool-grid">${thumbHTML(t)}</div>` : ''}
          <div class="drop-hint">把图片拖到这里，或点「上传图片」 · jpg/png/gif/webp/bmp，单张 ≤ 8MB</div>
        </div>
      </div>`;
    };

    const render = () => {
      const body = $('#pool-body');
      if (!body) return; // 用户已经切走
      if (!pool.dir) {
        body.innerHTML = '<div class="empty">图池目录未配置（服务端没有传 imagesDir）</div>';
        return;
      }
      body.innerHTML = pool.tags.length
        ? pool.tags.map(tagHTML).join('')
        : '<div class="card"><div class="empty">还没有标签。点右上角「新建标签」，再往里传图。</div></div>';
    };

    const reload = async () => {
      pool = await api('/api/image-tags');
      render();
    };

    const doUpload = async (tag, fileList) => {
      const files = Array.from(fileList || []).filter(
        (f) => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp)$/i.test(f.name || ''),
      );
      if (!files.length) { bad('只能上传图片文件'); return; }

      let done = 0;
      const errs = [];
      for (const f of files) {
        try {
          await uploadImage(tag, f);
          done++;
        } catch (e) {
          errs.push(`${f.name}：${e.message}`);
        }
      }
      if (done) ok(`已上传 ${done} 张到「${tag}」`);
      if (errs.length) {
        bad(errs.slice(0, 2).join('；') + (errs.length > 2 ? ` 等 ${errs.length} 个失败` : ''));
      }
      await reload();
    };

    bindActions(el, {
      'new-tag': () => {
        $('#pool-new').style.display = '';
        $('#pool-new-name').focus();
      },
      'cancel-new': () => { $('#pool-new').style.display = 'none'; },

      'create-tag': async (btn) => {
        const name = $('#pool-new-name').value.trim();
        const note = $('#pool-new-note').value.trim();
        if (!name) { bad('标签名不能为空'); return; }
        btn.disabled = true;
        try {
          await api('/api/image-tags', { method: 'PUT', body: { name, note } });
          $('#pool-new-name').value = '';
          $('#pool-new-note').value = '';
          $('#pool-new').style.display = 'none';
          ok('标签已创建');
          await reload();
        } catch (e) {
          bad(e.message);
        } finally {
          btn.disabled = false;
        }
      },

      'save-note': async (btn) => {
        const tag = btn.dataset.tag;
        const card = btn.closest('.pool-tag');
        const note = card.querySelector('textarea[data-note]').value.trim();
        btn.disabled = true;
        try {
          await api('/api/image-tags', { method: 'PUT', body: { name: tag, note } });
          ok('备注已保存');
          await reload();
        } catch (e) {
          bad(e.message);
        } finally {
          btn.disabled = false;
        }
      },

      rename: async (btn) => {
        const from = btn.dataset.tag;
        const to = window.prompt(`把「${from}」改成：`, from);
        if (to === null) return;
        try {
          await api('/api/image-tags/rename', { method: 'POST', body: { from, to: to.trim() } });
          ok('已改名');
          await reload();
        } catch (e) {
          bad(e.message);
        }
      },

      'del-tag': async (btn) => {
        const tag = btn.dataset.tag;
        if (!window.confirm(`删除标签「${tag}」？标签里还有图的话会先被拦下来。`)) return;
        try {
          await api('/api/image-tags?name=' + encodeURIComponent(tag), { method: 'DELETE' });
          ok('标签已删除');
          await reload();
        } catch (e) {
          bad(e.message);
        }
      },

      'del-img': async (btn) => {
        const tag = btn.dataset.tag;
        const name = btn.dataset.name;
        if (!window.confirm(`删除「${tag}」里的 ${name}？`)) return;
        try {
          await api(
            '/api/images?tag=' + encodeURIComponent(tag) + '&name=' + encodeURIComponent(name),
            { method: 'DELETE' },
          );
          ok('已删除');
          await reload();
        } catch (e) {
          bad(e.message);
        }
      },

      pick: (btn) => {
        const input = btn.closest('.pool-tag').querySelector('input[type=file]');
        if (input) input.click();
      },
    });

    // 选文件与拖拽都落在 .drop 上：前者靠 input 的 change，
    // 后者靠容器上的三个事件（dragover 必须 preventDefault 才会触发 drop）
    el.addEventListener('change', (e) => {
      const input = e.target.closest('input[type=file]');
      if (!input || !input.files || input.files.length === 0) return;
      const tag = input.closest('.drop').dataset.drop;
      void doUpload(tag, input.files).then(() => { input.value = ''; });
    });

    el.addEventListener('dragover', (e) => {
      const drop = e.target.closest('.drop');
      if (!drop) return;
      e.preventDefault();
      drop.classList.add('over');
    });

    el.addEventListener('dragleave', (e) => {
      const drop = e.target.closest('.drop');
      if (drop && !drop.contains(e.relatedTarget)) drop.classList.remove('over');
    });

    el.addEventListener('drop', (e) => {
      const drop = e.target.closest('.drop');
      if (!drop) return;
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer && e.dataTransfer.files.length) {
        void doUpload(drop.dataset.drop, e.dataTransfer.files);
      }
    });

    reload().catch(errInto('#pool-body'));
  }

  /* ================= 人格 ================= */

  function viewPersonas(el) {
    el.innerHTML = `<div class="page-head">
        <div><h2>人格</h2><div class="desc">系统提示词；格式约束由程序强制追加，不可编辑</div></div>
        <button class="btn ghost" data-act="new">新建人格</button>
      </div>
      <div class="card">
        <div id="ps-list"><div class="empty">加载中…</div></div>
        <div class="note" style="margin-top:10px">
          想给不同的群 / 私聊配不同人格？到「会话」页，在每行右侧的人格下拉里直接指定。
          标着「使用中」的是全局默认人格，没有单独指定的会话都用它。
        </div>
      </div>
      <div class="card" id="ps-editor" style="display:none">
        <h3 id="ps-ed-title">编辑人格</h3>
        <div class="field">
          <label>人格名</label>
          <input type="text" id="ps-name" placeholder="例如：默认、毒舌助手">
          <div class="note">同名即覆盖，改名会新建一条。</div>
        </div>
        <div class="field">
          <label>系统提示词</label>
          <textarea id="ps-prompt" rows="10"
            placeholder="You are a helpful assistant"></textarea>
          <div class="note">
            可用变量：{{time}} {{group_name}} {{nickname}} {{bot_name}}。
            结尾会自动追加「纯文本、不用 Markdown、1-3 句」等格式约束。
          </div>
        </div>
        <div class="row end">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn" data-act="save-persona">保存</button>
        </div>
      </div>`;

    const openEditor = (p) => {
      $('#ps-editor').style.display = '';
      $('#ps-ed-title').textContent = p ? '编辑人格：' + p.name : '新建人格';
      $('#ps-name').value = p ? p.name : '';
      $('#ps-prompt').value = p ? p.system_prompt : 'You are a helpful assistant';
      $('#ps-name').focus();
      $('#ps-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    const load = async () => {
      const d = await api('/api/personas');
      if (!$('#ps-list')) return; // 用户已经切走
      const items = d.items || [];
      if (!items.length) {
        $('#ps-list').innerHTML = '<div class="empty">还没有人格</div>';
        return;
      }
      $('#ps-list').innerHTML = `
        <table>
          <thead><tr><th>名称</th><th>状态</th><th>更新时间</th><th style="width:150px"></th></tr></thead>
          <tbody>
            ${items.map((p) => `
              <tr>
                <td>${esc(p.name)}</td>
                <td>${p.active ? '<span class="tag on">使用中</span>' : '<span class="tag">未启用</span>'}</td>
                <td class="dim nowrap">${esc(fmtTime(p.updated_at))}</td>
                <td class="nowrap">
                  <button class="btn ghost sm" data-act="edit" data-id="${p.id}">编辑</button>
                  ${p.active ? '' : `<button class="btn sm" data-act="activate" data-id="${p.id}">启用</button>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`;
      el._personas = items;
    };

    bindActions(el, {
      new: () => openEditor(null),
      cancel: () => { $('#ps-editor').style.display = 'none'; },
      edit: (btn) => {
        const p = (el._personas || []).find((x) => String(x.id) === btn.dataset.id);
        if (p) openEditor(p);
      },
      activate: async (btn) => {
        try {
          await api('/api/personas/activate', { method: 'POST', body: { id: Number(btn.dataset.id) } });
          ok('已切换人格');
          await load();
        } catch (e) { bad(e.message); }
      },
      'save-persona': async (btn) => {
        const name = $('#ps-name').value.trim();
        const prompt = $('#ps-prompt').value;
        if (!name) return bad('人格名不能为空');
        if (!prompt.trim()) return bad('系统提示词不能为空');
        btn.disabled = true;
        try {
          await api('/api/personas', { method: 'PUT', body: { name, system_prompt: prompt } });
          ok('已保存');
          $('#ps-editor').style.display = 'none';
          await load();
        } catch (e) {
          bad(e.message);
        } finally {
          btn.disabled = false;
        }
      },
    });

    load().catch(errInto('#ps-list'));
  }

  /* ================= 会话 ================= */

  // 会话记录里的一条消息。
  //
  // 排版的三条原则，都是老版本踩过的坑：
  //   1. 元信息（角色/时间/token）放气泡**外**。塞在气泡里时，那行灰色小字
  //      紧贴着正文，一屏看下去分不清哪句是模型说的；
  //   2. 正文先 trim 再折叠连续换行。模型输出常带尾部换行，配合 pre-wrap
  //      会在气泡里撑出好几行空白，气泡高度能比内容高三倍；
  //   3. 入库时补的「（附图 N 张）」是备注不是台词，渲染成徽标，不混进正文。
  function renderMessage(m) {
    const isUser = m.role === 'user';
    let text = String(m.content == null ? '' : m.content)
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    let chip = '';
    const hit = text.match(/（附图 (\d+) 张）/);
    if (hit) {
      chip = `<span class="img-chip">附图 ${esc(hit[1])} 张</span>`;
      // 标记可能贴在正文末尾（"说的啥（附图 1 张）"），摘掉后要把两侧的空格收干净
      text = (text.slice(0, hit.index) + text.slice(hit.index + hit[0].length)).trim();
    }

    // 空内容（早期脏数据、或只有一段被清掉的标记）留一个占位，
    // 否则这一行只剩头部元信息，看起来像渲染失败。
    let bubble;
    if (text !== '') {
      bubble = `<div class="bubble">${esc(text)}</div>`;
    } else if (chip === '') {
      bubble = '<div class="bubble muted">（空消息）</div>';
    } else {
      bubble = '';
    }
    return `<div class="msg ${isUser ? 'user' : 'bot'}">
      <div class="msg-head">
        <span class="who">${isUser ? '用户' : '助手'}</span>
        <span class="when">${esc(fmtStamp(m.created_at))}</span>
        <span class="tok">${fmtInt(m.tokens)} tok</span>
      </div>
      ${bubble}${chip === '' ? '' : `<div class="msg-extra">${chip}</div>`}
    </div>`;
  }

  // 对话里的时间戳按"今天只显示时分秒"来写：一屏全是完整日期会把
  // 真正要看的正文挤到不可见的地方。
  function fmtStamp(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime()) || d.getFullYear() < 1970) return '—';
    const p = (x) => String(x).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    return sameDay ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  }

  function viewSessions(el) {
    el.innerHTML = `<div class="page-head">
        <div><h2>会话</h2><div class="desc">群聊与私聊的上下文记录。每行的「设置」里可以单独指定人格与各项规则</div></div>
        <button class="btn ghost" data-act="toggle-preset">添加对话对象</button>
      </div>
      <div class="card" id="ss-preset" style="display:none">
        <h3>给还没说过话的群 / 好友预设人格
          <button class="btn ghost sm" data-act="cancel-preset">取消</button>
        </h3>
        <div class="preset-form">
          <div class="cell">
            <span>筛选</span>
            <input id="ss-search" placeholder="搜群名、昵称或号码" autocomplete="off">
          </div>
          <div class="cell">
            <span>对话对象</span>
            <select id="ss-target"></select>
          </div>
          <div class="cell">
            <span>人格</span>
            <select id="ss-persona"></select>
          </div>
          <button class="btn" data-act="save-preset">指定</button>
        </div>
        <p class="note" id="ss-preset-note">列表里只有还没产生过消息的对象；已经有会话的，点那一行的「设置」就行。</p>
        <div class="preset-form">
          <div class="cell">
            <span>手动填写会话 ID（列表里找不到时用）</span>
            <input id="ss-manual" placeholder="group:群号 或 private:QQ号" autocomplete="off">
          </div>
        </div>
      </div>
      <div class="card"><div id="ss-list"><div class="empty">加载中…</div></div></div>
      <div class="card" id="ss-detail" style="display:none">
        <h3 id="ss-detail-title">对话记录</h3>
        <div class="chat" id="ss-chat"></div>
      </div>`;

    // 这几份状态要在 load 与预设表单之间共享：候选人要知道哪些已经有会话了，
    // 表格要知道人格清单。放在闭包里而不是每次重新取，是因为打开预设面板
    // 会连着调 /api/groups，协议端拉一次群列表可能要几百毫秒。
    let personas = [];
    let knownIds = new Set();
    let candidates = [];
    // 会话行与「实时名字表」。sessions 里存的名字是说话那一刻记下的：
    // 老会话没有，群改过名也还是旧的，所以再拉一次群/好友列表兜底。
    // 拉不到（协议端离线）就静默用已有快照或号码——这一列不值得拖垮整页。
    let rows = [];
    let names = new Map();
    let namesLoaded = false;

    const nameOf = (s) => s.name || names.get(s.id) || '';
    // 操作按钮上只挂了会话 ID，提示语/标题里想带名字得回表里查一次
    const labelOf = (id) => {
      const hit = rows.find((s) => s.id === id);
      return hit ? nameOf(hit) : '';
    };

    const rowOf = (s) => {
      const preset = s.preset === true;
      const name = nameOf(s);
      // 名字在上、号码在下：号码得留着——同名的群、改了备注的好友都可能撞上，
      // 出问题时用户要能一眼抄出群号去查
      const who = name
        ? `<div class="sess-name" title="${esc(name)}">${esc(name)}</div><div class="sess-id">${esc(s.id)}</div>`
        : `<span class="mono">${esc(s.id)}</span>`;
      // 「设置」对两种行都要有：预设行同样可能已经配了一套自己的规则。
      // 有独立设置时文案里带出来，省得用户挨个点进去看哪几个配过。
      const cfg = `<button class="btn ghost sm" data-act="cfg" data-id="${esc(s.id)}">${
        s.overrides ? '设置·独立' : '设置'
      }</button>`;
      const acts = preset
        ? `${cfg}<button class="btn ghost sm" data-act="unbind" data-id="${esc(s.id)}">取消预设</button>`
        : `${cfg}<button class="btn ghost sm" data-act="peek" data-id="${esc(s.id)}">查看</button>
           <button class="btn danger sm" data-act="clear" data-id="${esc(s.id)}">清空</button>`;
      return `<tr>
        <td>${who}</td>
        <td>${s.kind === 'group' ? '<span class="tag">群聊</span>' : '<span class="tag">私聊</span>'}</td>
        <td class="dim">${preset ? '—' : fmtInt(s.messages)}</td>
        <td class="dim nowrap">${preset ? '<span class="tag on">尚未对话</span>' : esc(fmtTime(s.updated_at))}</td>
        <td class="nowrap">${acts}</td>
      </tr>`;
    };

    const paint = () => {
      if (!$('#ss-list')) return; // 用户已经切走
      if (!rows.length) {
        $('#ss-list').innerHTML =
          '<div class="empty">还没有任何会话。点右上角「添加对话对象」，可以给还没说过话的群或好友预设人格。</div>';
        return;
      }
      $('#ss-list').innerHTML = `
        <table>
          <thead><tr><th>会话</th><th>类型</th><th>消息数</th><th>最后活跃</th><th style="width:240px"></th></tr></thead>
          <tbody>${rows.map(rowOf).join('')}</tbody>
        </table>`;
    };

    const load = async () => {
      // 人格清单和会话一起取：下拉里只有人名不够，没有选项时用户就不知道该建人格
      const [d, dp] = await Promise.all([
        api('/api/sessions'),
        api('/api/personas').catch(() => ({ items: [] })),
      ]);
      if (!$('#ss-list')) return; // 用户已经切走
      rows = d.items || [];
      personas = dp.items || [];
      knownIds = new Set(rows.map((s) => s.id));
      fillPersonas();
      paint();
      // 先画再补名字：拉群列表可能几百毫秒（协议端离线时更久），
      // 放在渲染之前会让整张表跟着一起等
      loadNames();
    };

    // 名字的兜底来源。只拉一次：这一页来回操作时不必反复问协议端。
    const loadNames = async () => {
      if (namesLoaded) return;
      namesLoaded = true;
      const [gs, fs] = await Promise.all([
        api('/api/groups').catch(() => ({ items: [] })),
        api('/api/friends').catch(() => ({ items: [] })),
      ]);
      const next = new Map();
      for (const g of gs.items || []) {
        if (g.group_name) next.set('group:' + g.group_id, g.group_name);
      }
      for (const f of fs.items || []) {
        // 备注优先：自己起的备注比对方昵称好认，跟预设下拉的取法保持一致
        const n = f.remark || f.nickname || '';
        if (n) next.set('private:' + f.user_id, n);
      }
      if (!next.size) return;
      names = next;
      paint();
    };

    // 已加入的群 / 已加的好友，减去已经有会话的，剩下的就是可以预设的对象。
    // 差集在前端做：后端只回原始列表，不必为"还没说话"再造一份数据。
    const renderTargets = () => {
      const sel = $('#ss-target');
      const search = $('#ss-search');
      // 拉列表是异步的，回来时用户可能已经切页了；这里和 load() 一样要能空跑
      if (!sel || !search) return;
      const q = (search.value || '').trim().toLowerCase();
      const avail = candidates.filter(
        (c) =>
          !knownIds.has(c.id) &&
          (q === '' || c.name.toLowerCase().includes(q) || c.id.includes(q)),
      );
      if (!avail.length) {
        sel.innerHTML = `<option value="">${
          candidates.length ? '都已有会话了，点那一行的「设置」即可改' : '没有可用对象'
        }</option>`;
        return;
      }
      const keep = sel.value;
      sel.innerHTML = avail
        .map(
          (c) =>
            `<option value="${esc(c.id)}">${c.kind === 'group' ? '群' : '好友'} · ${esc(c.name)}${
              c.hint ? `（${esc(c.hint)}）` : ''
            }</option>`,
        )
        .join('');
      // 刷新后尽量停在原来那一项：用户搜完还没来得及点，重排不该把他选的东西换掉
      if (avail.some((c) => c.id === keep)) sel.value = keep;
    };

    const loadCandidates = async () => {
      const [gs, fs] = await Promise.all([
        api('/api/groups').catch((e) => ({ items: [], err: e.message })),
        api('/api/friends').catch((e) => ({ items: [], err: e.message })),
      ]);
      candidates = [
        ...(gs.items || []).map((g) => ({
          id: 'group:' + g.group_id,
          kind: 'group',
          name: g.group_name || String(g.group_id),
          hint: g.member_count ? `${g.member_count} 人` : '',
        })),
        ...(fs.items || []).map((f) => ({
          id: 'private:' + f.user_id,
          kind: 'private',
          name: f.remark || f.nickname || String(f.user_id),
          hint: f.remark && f.nickname ? f.nickname : '',
        })),
      ];
      const err = gs.err || fs.err;
      if (err) {
        // 协议端掉线时这两个接口是 502，不是前端 bug，把话说清楚
        $('#ss-preset-note').textContent = `拉取群 / 好友列表失败（${err}）——可以手动填写会话 ID。`;
      }
      renderTargets();
    };

    // 人格下拉要等 load 拿到清单才能填；单独抽出来是因为预设面板
    // 通常在 load 之后才被点开
    const fillPersonas = () => {
      $('#ss-persona').innerHTML = personas.length
        ? personas.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
        : '<option value="">没有可选人格</option>';
    };
    $('#ss-search').addEventListener('input', renderTargets);


    bindActions(el, {
      // 进这个会话的独立设置页。id 含冒号，必须编码后再拼进 hash，
      // 否则 URLSearchParams 解析出来会被截断。
      cfg: (btn) => {
        location.hash = '#/session-settings?id=' + encodeURIComponent(btn.dataset.id);
      },
      // 标题右侧的「取消」：跟右上角那个「添加对话对象」是同一个开关的两头，
      // 面板展开后按钮跑到了卡片里，用户不用再回到页头去找关闭的地方
      'cancel-preset': () => {
        $('#ss-preset').style.display = 'none';
        // 手填框一并清掉：留着上次的号码，下次点开很容易直接按「指定」，
        // 绑到的是上一个对象
        $('#ss-manual').value = '';
      },
      'toggle-preset': async () => {
        const box = $('#ss-preset');
        if (box.style.display !== 'none') {
          box.style.display = 'none';
          return;
        }
        box.style.display = '';
        $('#ss-search').focus();
        if (candidates.length > 0) {
          // 之前拉过，但候选的"已有会话"状态可能已经变了（刚绑完就重开面板）
          renderTargets();
          return;
        }
        $('#ss-target').innerHTML = '<option value="">加载中…</option>';
        try {
          await loadCandidates();
        } catch (e) {
          $('#ss-target').innerHTML = '<option value="">加载失败</option>';
          $('#ss-preset-note').textContent = `拉取失败（${e.message}）——可以手动填写会话 ID。`;
        }
      },
      'save-preset': async () => {
        // 手填优先：列表里没有的对象（临时会话、非好友私聊）只能这么加
        const manual = $('#ss-manual').value.trim();
        const id = manual !== '' ? manual : $('#ss-target').value;
        if (id === '') {
          bad('先选一个对话对象，或手动填写会话 ID');
          return;
        }
        // 前端挡一道，省一次请求；真正把关的是接口（主键写错会永远匹配不上）
        if (!/^(group|private):\d+$/.test(id)) {
          bad('会话 ID 格式应为 group:群号 或 private:QQ号');
          return;
        }
        const pid = Number($('#ss-persona').value);
        if (!Number.isInteger(pid) || pid <= 0) {
          bad('先选一个人格');
          return;
        }
        const hit = candidates.find((c) => c.id === id);
        try {
          await api('/api/sessions/persona', {
            method: 'POST',
            body: { id, persona_id: pid, name: hit ? hit.name : '' },
          });
          ok(hit ? `已为「${hit.name}」指定人格` : '已指定人格');
          $('#ss-manual').value = '';
          await load();
          renderTargets();
        } catch (e) {
          bad(e.message);
        }
      },
      unbind: async (btn) => {
        const id = btn.dataset.id;
        if (!confirm(`取消 ${id} 的人格预设？它会回到跟随默认人格。`)) return;
        try {
          await api('/api/sessions/persona', { method: 'POST', body: { id, persona_id: 0 } });
          ok('已取消预设');
          await load();
          renderTargets();
        } catch (e) {
          bad(e.message);
        }
      },
      peek: async (btn) => {
        const id = btn.dataset.id;
        const label = labelOf(id);
        $('#ss-detail').style.display = '';
        $('#ss-detail-title').textContent = label ? `对话记录 · ${label}` : '对话记录 · ' + id;
        $('#ss-chat').innerHTML = '<div class="empty">加载中…</div>';
        try {
          const d = await api('/api/sessions/messages?id=' + encodeURIComponent(id) + '&limit=100');
          const items = d.items || [];
          if (!items.length) {
            $('#ss-chat').innerHTML = '<div class="empty">这个会话还没有消息</div>';
            return;
          }
          $('#ss-chat').innerHTML = items.map(renderMessage).join('');
          $('#ss-chat').scrollTop = $('#ss-chat').scrollHeight;
        } catch (e) {
          $('#ss-chat').innerHTML = `<div class="err-inline">${esc(e.message)}</div>`;
        }
      },
      clear: async (btn) => {
        const id = btn.dataset.id;
        const label = labelOf(id);
        if (!confirm(`清空${label ? `「${label}」` : ''}会话 ${id} 的全部上下文？此操作不可撤销。`)) return;
        try {
          await api('/api/sessions/clear', { method: 'POST', body: { id } });
          ok('已清空');
          $('#ss-detail').style.display = 'none';
          await load();
        } catch (e) { bad(e.message); }
      },
    });

    load().catch(errInto('#ss-list'));
  }

  /* ================= 用量 ================= */

  function viewUsage(el) {
    el.innerHTML = `<div class="page-head">
        <div><h2>用量</h2><div class="desc">按 DeepSeek 峰谷价估算，仅供参考</div></div>
      </div>
      <div id="us-body"><div class="empty">加载中…</div></div>`;

    api('/api/usage?days=7').then((d) => {
      if (!$('#us-body')) return; // 用户已经切走
      const today = d.today || {};
      const items = d.items || [];
      const max = Math.max(1, ...items.map((x) => x.requests || 0));

      $('#us-body').innerHTML = `
        <div class="card">
          <h3>今日</h3>
          <div class="grid c4">
            <div class="metric"><div class="k">请求次数</div><div class="v" id="us-req">${fmtInt(today.requests)}</div></div>
            <div class="metric"><div class="k">输入 token</div><div class="v sm mono">${fmtInt(today.prompt_tokens)}</div></div>
            <div class="metric"><div class="k">输出 token</div><div class="v sm mono">${fmtInt(today.completion_tokens)}</div></div>
            <div class="metric"><div class="k">估算花费</div><div class="v">${fmtCost(today.cost_cny)}</div></div>
          </div>
        </div>

        <div class="card">
          <h3>最近 7 天请求量</h3>
          ${items.length ? `
            <div class="bars">
              ${items.map((x) => {
                const h = Math.max(3, Math.round(((x.requests || 0) / max) * 100));
                return `<div class="bar-col">
                  <div class="val">${x.requests || 0}</div>
                  <div class="bar" style="height:${h}%"></div>
                  <div class="lbl">${esc(String(x.day || '').slice(5))}</div>
                </div>`;
              }).join('')}
            </div>` : '<div class="empty">还没有用量记录</div>'}
        </div>

        <div class="card">
          <h3>明细</h3>
          ${items.length ? `
            <table>
              <thead><tr><th>日期</th><th>请求</th><th>输入</th><th>输出</th><th>高峰请求</th><th>花费</th></tr></thead>
              <tbody>
                ${items.slice().reverse().map((x) => `
                  <tr>
                    <td class="mono">${esc(x.day)}</td>
                    <td>${fmtInt(x.requests)}</td>
                    <td class="dim">${fmtInt(x.prompt_tokens)}</td>
                    <td class="dim">${fmtInt(x.completion_tokens)}</td>
                    <td class="dim">${fmtInt(x.peak_requests)}</td>
                    <td>${fmtCost(x.cost_cny)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>` : '<div class="empty">还没有用量记录</div>'}
        </div>`;
    }).catch(errInto('#us-body'));
  }

  /* ================= 账号 ================= */

  function viewAccount(el) {
    el.innerHTML = `<div class="page-head">
        <div><h2>账号</h2><div class="desc">面板凭据与两步验证</div></div>
      </div>

      <div class="card">
        <h3>账户名 <span class="hint">登录面板时使用</span></h3>
        <div class="grid c2">
          <div class="field"><label>新用户名</label>
            <input type="text" id="ac-name" autocomplete="username" value="${esc(app.user || '')}" maxlength="32">
            <div class="note">2–32 个字符，不能含空格，也不能含 / \ : ? # %。</div></div>
          <div class="field"><label>当前密码</label>
            <input type="password" id="ac-name-pw" autocomplete="current-password">
            <div class="note">改的是登录身份，需要确认是本人操作。</div></div>
        </div>
        <button class="btn" data-act="name">更新用户名</button>
      </div>

      <div class="card">
        <h3>修改密码</h3>
        <div class="grid c3">
          <div class="field"><label>原密码</label><input type="password" id="ac-old" autocomplete="current-password"></div>
          <div class="field"><label>新密码</label><input type="password" id="ac-new" autocomplete="new-password">
            <div class="note">至少 12 位。</div></div>
          <div class="field"><label>确认新密码</label><input type="password" id="ac-new2" autocomplete="new-password"></div>
        </div>
        <button class="btn" data-act="pw">更新密码</button>
      </div>

      <div class="card">
        <h3>两步验证 <span class="hint" id="ac-totp-state">—</span></h3>
        <div id="ac-totp-body"><div class="empty">加载中…</div></div>
      </div>`;

    const renderTotp = (enabled) => {
      const state = $('#ac-totp-state');
      const body = $('#ac-totp-body');
      if (!state || !body) return;
      state.textContent = enabled ? '已开启' : '未开启';

      if (enabled) {
        body.innerHTML = `
          <div class="field" style="max-width:240px">
            <label>当前验证码</label>
            <input type="text" id="ac-off-code" inputmode="numeric" maxlength="6" placeholder="6 位数字">
            <div class="note">关闭前需要验证一次，防止会话被盗后直接关掉。</div>
          </div>
          <button class="btn danger" data-act="totp-off">关闭两步验证</button>`;
        return;
      }

      body.innerHTML = `
        <div class="note" style="margin-bottom:12px">
          开启后登录需要输入验证器 App（如 1Password、Authy、Google Authenticator）里的 6 位动态码。
        </div>
        <button class="btn ghost" data-act="totp-setup">生成密钥</button>
        <div id="ac-totp-setup" style="margin-top:14px"></div>`;
    };

    bindActions(el, {
      name: async (btn) => {
        const name = $('#ac-name').value.trim();
        const pw = $('#ac-name-pw').value;
        if (name === (app.user || '')) return bad('新用户名与当前相同');
        btn.disabled = true;
        try {
          // 密码错时服务端回 401：这个 401 是"当前密码错"，不是会话过期，
          // 见 api() 的 keepSession —— 否则输错一次就被踢回登录页。
          const d = await api('/api/auth/username', {
            method: 'POST',
            body: { name, password: pw },
            keepSession: true,
          });
          app.user = d.user;
          const side = $('#side-user');
          if (side) side.textContent = d.user;
          $('#ac-name').value = d.user;
          $('#ac-name-pw').value = '';
          ok('用户名已更新，下次登录请用新用户名');
        } catch (e) {
          bad(e.message);
        } finally {
          btn.disabled = false;
        }
      },

      pw: async (btn) => {
        const oldPw = $('#ac-old').value;
        const n1 = $('#ac-new').value;
        const n2 = $('#ac-new2').value;
        if (n1.length < 12) return bad('新密码至少 12 位');
        if (n1 !== n2) return bad('两次输入的新密码不一致');
        btn.disabled = true;
        try {
          await api('/api/auth/password', {
            method: 'POST',
            body: { old: oldPw, new: n1 },
            keepSession: true,
          });
          ok('密码已更新');
          $('#ac-old').value = $('#ac-new').value = $('#ac-new2').value = '';
        } catch (e) {
          bad(e.message);
        } finally {
          btn.disabled = false;
        }
      },

      'totp-setup': async () => {
        try {
          const d = await api('/api/auth/totp/setup', { method: 'POST' });
          $('#ac-totp-setup').innerHTML = `
            <div class="field" style="max-width:520px">
              <label>密钥（手动添加到验证器）</label>
              <input type="text" class="mono" readonly value="${esc(d.secret)}">
              <div class="note">或直接使用这个 otpauth 链接：<br>
                <span class="mono" style="word-break:break-all">${esc(d.url)}</span>
              </div>
            </div>
            <div class="field" style="max-width:240px">
              <label>输入验证器当前显示的验证码以完成开启</label>
              <input type="text" id="ac-on-code" inputmode="numeric" maxlength="6" placeholder="6 位数字">
            </div>
            <button class="btn" data-act="totp-on">确认开启</button>`;
        } catch (e) { bad(e.message); }
      },
      'totp-on': async () => {
        const code = ($('#ac-on-code') || {}).value || '';
        if (!/^\d{6}$/.test(code.trim())) return bad('请输入 6 位数字验证码');
        try {
          await api('/api/auth/totp/enable', { method: 'POST', body: { code: code.trim() } });
          ok('两步验证已开启');
          renderTotp(true);
        } catch (e) { bad(e.message); }
      },
      'totp-off': async () => {
        const code = ($('#ac-off-code') || {}).value || '';
        if (!/^\d{6}$/.test(code.trim())) return bad('请输入 6 位数字验证码');
        if (!confirm('确认关闭两步验证？')) return;
        try {
          await api('/api/auth/totp/disable', { method: 'POST', body: { code: code.trim() } });
          ok('已关闭');
          renderTotp(false);
        } catch (e) { bad(e.message); }
      },
    });

    api('/api/auth/status').then((d) => renderTotp(!!d.totp_enabled))
      .catch(errInto('#ac-totp-body'));
  }

  /* ================= 登录 QQ ================= */

  /* 扫码登录页。
   *
   * 这个页面替代了「再开一个 6099 端口、输 WebUI token」的旧流程：
   * 服务端持有 token，浏览器只看到「要二维码 / 报状态」这两件事。
   * 二维码本身是服务端用 qrcode 包生成的 PNG data URL——
   * 协议端给的那个地址会 302 跳到 im.qq.com 落地页，当图片用是坏的。
   */
  function viewQQ(el) {
    let qrContent = '';
    let qrBusy = false;
    // 上次取码失败的时间。协议端没起来时状态轮询每 3 秒会顺手重试一次取码，
    // 不压一压的话日志里就是每 3 秒一条 ERROR，真正的故障反而被淹掉。
    let qrFailAt = 0;
    const QR_RETRY_MS = 20000;
    let loggedIn = false;

    el.innerHTML = `
      <div class="page-head">
        <div>
          <h2>登录 QQ</h2>
          <div class="desc">扫码把机器人账号登进协议端，登录后即可在群里对话</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <h3>账号状态</h3>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="dot" id="qq-dot"></span>
          <span id="qq-state" style="font-size:13px">正在查询…</span>
          <span class="mono" id="qq-uin" style="color:var(--fg-dim);font-size:12px"></span>
          <button class="btn ghost sm" data-act="qq-refresh" style="margin-left:auto">重新查询</button>
          <button class="btn ghost sm" data-act="qq-logout" id="qq-logout" style="display:none">退出登录</button>
        </div>
        <div id="qq-hint" style="margin-top:10px;font-size:11.5px;color:var(--fg-mute);line-height:1.7"></div>
      </div>

      <div class="card" id="qq-login-card" style="display:none">
        <h3>扫码登录 <span class="hint">二维码约 2 分钟失效，过期会自动换新</span></h3>
        <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
          <div style="text-align:center">
            <div id="qq-qr-box" style="width:220px;height:220px;display:flex;align-items:center;
                 justify-content:center;background:var(--bg-elev);border-radius:10px;
                 border:1px solid var(--line)">
              <span style="color:var(--fg-mute);font-size:12px">加载中…</span>
            </div>
            <button class="btn ghost sm" data-act="qq-reload-qr" style="margin-top:10px">刷新二维码</button>
          </div>
          <div style="flex:1;min-width:220px;font-size:12.5px;line-height:1.9;color:var(--fg-dim)">
            <div>1. 手机 QQ 右上角「+」→「扫一扫」</div>
            <div>2. 扫描左侧二维码</div>
            <div>3. 手机上点确认登录</div>
            <div style="margin-top:10px;color:var(--fg-mute);font-size:11.5px">
              登录成功后本页会自动跳到「已登录」。<br>
              同一时间只能登录一个 QQ 号。
            </div>
          </div>
        </div>
      </div>

      <div class="card" id="qq-saved-card" style="display:none;margin-top:16px">
        <h3>已保存的账号 <span class="hint">本地登录过，可一键重登</span></h3>
        <div id="qq-saved-list" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>`;

    function renderState(d) {
      const dot = $('#qq-dot');
      if (!dot) return;

      if (!d.configured) {
        dot.className = 'dot bad';
        $('#qq-state').textContent = '未配置协议端 WebUI';
        $('#qq-hint').innerHTML =
          '服务端缺少 QQBOT_WEBUI_TOKEN，或 <code>napcat.webui</code> 地址不对。' +
          '在 <code>etc/env</code> 里补上 token 后重启容器。';
        return;
      }

      loggedIn = !!d.login && !d.offline;
      dot.className = 'dot ' + (loggedIn ? 'ok' : d.offline ? 'warn' : 'bad');

      if (loggedIn) {
        $('#qq-state').textContent = '已登录';
        $('#qq-uin').textContent = d.uin ? `${d.nick || ''} (${d.uin})` : '';
        $('#qq-hint').innerHTML =
          '机器人已在线，可以直接在 QQ 里 @ 它说话了。换号请先退出登录。' +
          '若「总览」里协议端仍显示未连接，等 10 秒左右——服务端正在自动开启反向 WS（:3001）。';
      } else if (d.offline) {
        $('#qq-state').textContent = '已登录但离线';
        $('#qq-uin').textContent = d.uin ? `${d.nick || ''} (${d.uin})` : '';
        $('#qq-hint').textContent = 'QQ 侧掉线了，需要重新扫码登录。';
      } else {
        $('#qq-state').textContent = d.error ? '登录失败' : '未登录';
        $('#qq-uin').textContent = '';
        $('#qq-hint').textContent = d.error || '';
      }

      $('#qq-login-card').style.display = loggedIn ? 'none' : '';
      $('#qq-saved-card').style.display = loggedIn ? 'none' : '';
      // 已登录才给「退出登录」：换号必须先退，否则协议端会拒绝新的登录
      const lo = $('#qq-logout');
      if (lo) lo.style.display = d.login ? '' : 'none';
    }

    async function loadQr(force) {
      if (qrBusy || loggedIn) return;
      if (!force && Date.now() - qrFailAt < QR_RETRY_MS) return;
      qrBusy = true;
      const box = $('#qq-qr-box');
      try {
        const d = await api('/api/qq/qrcode', { method: 'POST' });
        if (!d) return;
        // 协议端说已经登录了（发码会被它拒绝成 "QQ Is Logined"）：
        // 这不是错误，只是状态轮询还没轮到。收起二维码并立刻同步一次状态。
        if (d.logined) {
          qrContent = '';
          if (box) box.innerHTML = '';
          await refresh();
          return;
        }
        if (!box) return;
        qrContent = d.image || '';
        // 200 但没图（协议端还没准备好）：也算"这次没拿到"，一起退避，
        // 否则状态轮询每 3 秒就会来问一次，还顺带把协议端的二维码刷一遍
        if (qrContent === '') qrFailAt = Date.now();
        box.innerHTML = qrContent
          ? `<img src="${esc(qrContent)}" alt="登录二维码" width="200" height="200"
                  style="border-radius:8px;background:#fff;padding:6px">`
          : '<span style="color:var(--fg-mute);font-size:12px">协议端未返回二维码</span>';
      } catch (e) {
        qrFailAt = Date.now();
        if (box) {
          box.innerHTML = `<span style="color:var(--fg-dim);font-size:11.5px;padding:12px;
            text-align:center;line-height:1.7">${esc(e.message)}</span>`;
        }
      } finally {
        qrBusy = false;
      }
    }

    async function loadSaved() {
      const list = $('#qq-saved-list');
      if (!list) return;
      try {
        const d = await api('/api/qq/quick-login');
        const items = (d && d.items) || [];
        $('#qq-saved-card').style.display = items.length > 0 && !loggedIn ? '' : 'none';
        list.innerHTML = items
          .map(
            (it) => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;
                 background:var(--bg-elev);border-radius:8px">
              <span class="mono" style="font-size:12px">${esc(it.uin)}</span>
              <span style="font-size:12px;color:var(--fg-dim)">${esc(it.nick || '')}</span>
              <button class="btn ghost sm" data-act="qq-quick" data-uin="${esc(it.uin)}"
                      style="margin-left:auto">登录</button>
            </div>`,
          )
          .join('');
      } catch (_) {
        // 拿不到快捷登录列表不影响扫码
      }
    }

    const refresh = async () => {
      let d;
      try {
        d = await api('/api/qq/status');
      } catch (_) {
        return;
      }
      // 请求返回时用户可能已经切走了
      if (!$('#qq-dot')) return;
      const wasLoggedIn = loggedIn;
      renderState(d);
      if (!d.configured) return;
      if (!loggedIn && !wasLoggedIn) {
        if (!$('#qq-qr-box img')) loadQr();
      }
    };

    // 先问状态再决定要不要取码：之前这里和 refresh() 并发调 loadQr()，
    // 那会儿 loggedIn 还是初值 false，守卫形同不存在——已登录的机器也要
    // 白挨一次"QQ Is Logined"。refresh 内部会在未登录时补取码。
    refresh();
    loadSaved();

    const statusTimer = setInterval(refresh, 3000);
    stops.push(() => clearInterval(statusTimer));

    // 二维码会过期，但重新要一张会让协议端刷新二维码，
    // 手机正在扫的时候刷新会把用户扫的那张作废，所以间隔取保守的 100 秒。
    const qrTimer = setInterval(() => {
      if (!loggedIn) loadQr();
    }, 100000);
    stops.push(() => clearInterval(qrTimer));

    bindActions(el, {
      'qq-refresh': async () => {
        await refresh();
        ok('已刷新');
      },
      'qq-reload-qr': async () => {
        // 手动刷新要绕过退避：用户点它就是因为想立刻重试
        qrFailAt = 0;
        await loadQr(true);
      },
      'qq-logout': async (btn) => {
        if (!confirm('退出后机器人会离线，需要重新扫码才能恢复。确定退出？')) return;
        btn.disabled = true;
        try {
          await api('/api/qq/logout', { method: 'POST' });
          ok('已退出登录');
          loggedIn = false;
          setTimeout(refresh, 800);
          // 退出后协议端要一点时间落状态，稍等再取码，别紧接着挨一次拒绝
          setTimeout(() => loadQr(true), 800);
        } catch (e) {
          bad(e.message);
        } finally {
          btn.disabled = false;
        }
      },
      'qq-quick': async (btn) => {
        const uin = btn.dataset.uin;
        btn.disabled = true;
        try {
          await api('/api/qq/quick-login', { method: 'POST', body: { uin } });
          ok('已发起登录，稍候几秒');
          setTimeout(refresh, 1500);
        } catch (e) {
          bad(e.message);
        } finally {
          btn.disabled = false;
        }
      },
    });
  }

  /* ================= 协议端网络配置 ================= */

  /* NapCat「高级网络配置」的等价页。
   *
   * 为什么不做 /webui 反代：反代 NapCat 的 WebUI 得把 WebSocket 一起代理，
   * 还要对齐它的 cookie、静态资源路径、API 前缀，出问题时极难排查；
   * 而用户真正会改的就那几项（反向 WS 端口、上报格式、token）。
   * 直接调协议端的 OB11Config 接口做成这一页，代码量和风险都小一个数量级。
   *
   * 实测约束：OB11Config 要求 QQ 已登录（未登录协议端返回 Not Login），
   * 所以先查登录状态，未登录就把编辑区藏起来，引导去「登录」页。
   */
  /* ================= 协议端（保活面板） ================= */

  /* 这里原本内嵌 NapCat 原生 WebUI。
   *
   * 现在只留"让机器人保持在线"的几项：账号在线状态、上不去时去扫码、
   * 换号能退出、3001 反向 WS 有没有开、连不上时能看到最近一次错误。
   * 插件、HTTP 客户端、上报格式、文件管理这些运维面一律不进来——
   * 把整套原生界面挂在 5666 上，等于把协议端的全部权限都挂在面板会话后面，
   * 而日常保活一件都用不到。真要改底层配置，用「网络」页，或者直接改
   * data/napcat 下的文件后重启容器。
   */
  function viewNapcat(el) {
    el.innerHTML = `
      <div class="page-head">
        <div>
          <h2>协议端</h2>
          <div class="desc">只看保持在线所需的状态；NapCat 原生管理界面已不再内嵌</div>
        </div>
        <button class="btn ghost" data-act="nc-check">重新检测</button>
      </div>

      <div class="grid c2" style="margin-bottom:16px">
        <div class="card">
          <h3>QQ 账号</h3>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span class="dot" id="nc-dot"></span>
            <span id="nc-state" style="font-size:13px">检测中…</span>
            <span class="mono" id="nc-uin" style="color:var(--fg-dim);font-size:12px"></span>
          </div>
          <div id="nc-hint" style="margin-top:10px;font-size:11.5px;color:var(--fg-mute);line-height:1.8"></div>
        </div>

        <div class="card">
          <h3>连接</h3>
          <div id="nc-links" style="display:flex;flex-direction:column;gap:10px;font-size:12.5px">
            <div class="empty">检测中…</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>操作</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" data-act="nc-login">去扫码登录</button>
          <button class="btn ghost" data-act="nc-logout" id="nc-logout" style="display:none">退出登录</button>
          <button class="btn ghost" data-act="nc-net">网络配置（改反向 WS）</button>
        </div>
        <div style="margin-top:12px;font-size:11.5px;color:var(--fg-mute);line-height:1.9">
          退出登录会让机器人立刻离线，之后必须重新扫码。<br>
          反向 WS 没开、或者要改上报格式与 token，都在「网络」页——它只动 OneBot 那一段配置。
        </div>
      </div>`;

    let alive = true;
    let qq = null;

    const setDot = (sel, kind) => {
      const n = $(sel);
      if (n) n.className = 'dot ' + kind;
    };

    /** 3001 反向 WS 是否开着。必须 QQ 已登录才读得到协议端配置。 */
    async function detectWs(q) {
      if (!q.configured) return { text: '—', ok: null };
      if (!q.login) return { text: '登录后可检测', ok: null };
      try {
        const d = await api('/api/qq/network');
        const list = d.config && Array.isArray(d.config.websocketServers) ? d.config.websocketServers : [];
        const hit = list.find(
          (s) => s && Number(s.port) === 3001 && s.enable !== false && s.enabled !== false,
        );
        return hit ? { text: '已开启 3001', ok: true } : { text: '未开启', ok: false };
      } catch (_) {
        return { text: '读取失败', ok: false };
      }
    }

    function renderQQ(q) {
      if (!q) {
        setDot('#nc-dot', 'bad');
        $('#nc-state').textContent = '无法查询';
        $('#nc-hint').textContent = '面板接口没有返回状态，稍后点「重新检测」。';
        return;
      }
      $('#nc-logout').style.display = q.login ? '' : 'none';
      $('#nc-uin').textContent = q.uin ? `${q.nick || ''} (${q.uin})` : '';

      if (!q.configured) {
        setDot('#nc-dot', 'bad');
        $('#nc-state').textContent = '未配置协议端';
        $('#nc-hint').innerHTML =
          '服务端没有 QQBOT_WEBUI_TOKEN，或 <code>napcat.webui</code> 地址不对。' +
          '这类问题只能改 <code>etc/env</code> 后重启容器，面板里修不了。';
        return;
      }
      if (q.login && !q.offline) {
        setDot('#nc-dot', 'ok');
        $('#nc-state').textContent = '在线';
        $('#nc-hint').textContent = '账号在线，机器人可以正常收发消息。';
        return;
      }
      if (q.offline) {
        setDot('#nc-dot', 'warn');
        $('#nc-state').textContent = '已登录但离线';
        $('#nc-hint').textContent = 'QQ 侧掉线了，去「登录」页重新扫码。';
        return;
      }
      setDot('#nc-dot', 'bad');
      $('#nc-state').textContent = q.error ? '登录失败' : '未登录';
      $('#nc-hint').textContent = q.error
        ? `协议端返回：${q.error}。按上面提示处理后重新扫码。`
        : '去「登录」页扫码，登录成功后会自动开反向 WS。';
    }

    function renderLinks(ov, ws) {
      const box = $('#nc-links');
      if (!box) return;
      const row = (k, text, ok) =>
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
        `<span style="color:var(--fg-dim)">${k}</span>` +
        '<span style="display:flex;align-items:center;gap:6px">' +
        (ok === null || ok === undefined ? '' : `<span class="dot ${ok ? 'ok' : 'bad'}"></span>`) +
        `<span>${esc(text)}</span></span></div>`;

      const parts = [];
      if (ov) {
        parts.push(row('OneBot 客户端', ov.connected ? '已连接' : '未连接', ov.connected));
        parts.push(row('机器人 QQ', ov.online ? '在线' : '离线', ov.online));
        parts.push(row('重连次数', String(ov.reconnects ?? 0), null));
        if (ov.last_error) parts.push(row('最近错误', ov.last_error, false));
      } else {
        parts.push(row('OneBot 客户端', '无法查询', false));
      }
      parts.push(row('反向 WS :3001', ws.text, ws.ok));
      box.innerHTML = parts.join('');
    }

    async function refresh(showToast) {
      const [a, b] = await Promise.allSettled([api('/api/qq/status'), api('/api/overview')]);
      if (!alive) return;
      qq = a.status === 'fulfilled' ? a.value : null;
      const ov = b.status === 'fulfilled' ? b.value : null;
      const ws = await detectWs(qq || { configured: false, login: false });
      if (!alive) return;
      renderQQ(qq);
      renderLinks(ov, ws);
      if (showToast) ok('已刷新');
    }

    bindActions(el, {
      'nc-check': () => refresh(true),
      'nc-login': () => {
        location.hash = '#/qq';
      },
      'nc-net': () => {
        location.hash = '#/network';
      },
      'nc-logout': async (btn) => {
        if (!confirm('退出后机器人会离线，需要重新扫码才能恢复。确定退出？')) return;
        btn.disabled = true;
        try {
          await api('/api/qq/logout', { method: 'POST' });
          ok('已退出登录');
          await refresh();
        } catch (e) {
          bad(e.message);
        } finally {
          btn.disabled = false;
        }
      },
    });

    refresh();
    // 慢轮询：这一页只是"看一眼还活着吗"，10 秒足够，也不必像登录页那样频繁
    const timer = setInterval(() => refresh(), 10_000);
    stops.push(() => clearInterval(timer));
    stops.push(() => {
      alive = false;
    });
  }

  function viewNetwork(el) {
    // 协议端读出来的配置原本是字符串还是对象：保存时要按原样回传
    let asString = false;

    el.innerHTML = `
      <div class="page-head">
        <div>
          <h2>网络配置</h2>
          <div class="desc">协议端（NapCat）的 OneBot11 网络配置，不用再打开 6099 那个 WebUI</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <h3>当前生效的监听</h3>
        <div class="grid c4">
          <div class="metric">
            <div class="k">反向 WS</div>
            <div class="v sm mono" id="nw-ws">—</div>
          </div>
          <div class="metric">
            <div class="k">WS 客户端</div>
            <div class="v sm mono" id="nw-wsc">—</div>
          </div>
          <div class="metric">
            <div class="k">HTTP 服务端</div>
            <div class="v sm mono" id="nw-http">—</div>
          </div>
          <div class="metric">
            <div class="k">上报格式</div>
            <div class="v sm mono" id="nw-fmt">—</div>
          </div>
        </div>
        <div id="nw-hint" style="margin-top:12px;font-size:11.5px;color:var(--fg-mute);line-height:1.8">
          正在查询…
        </div>
      </div>

      <div class="card" id="nw-edit" style="display:none">
        <h3>编辑配置 <span class="hint">协议端原始 JSON，保存即生效</span></h3>
        <textarea id="nw-json" spellcheck="false" wrap="off"
                  style="width:100%;min-height:360px"></textarea>
        <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
          <button class="btn" data-act="nw-save">保存</button>
          <button class="btn ghost" data-act="nw-fmt">格式化</button>
          <button class="btn ghost" data-act="nw-reload">重新读取</button>
          <button class="btn ghost" data-act="nw-fix">修正反向 WS（:3001）</button>
        </div>
        <div style="margin-top:14px;font-size:11.5px;color:var(--fg-mute);line-height:1.9">
          保存后协议端会重启 OneBot 服务，「总览」与「协议端」会短暂显示未连接，几秒后自动恢复。<br>
          机器人默认连 <code>ws://napcat:3001</code>，所以至少要有一条<strong>启用</strong>的
          <code>websocketServers</code> 监听 3001。<br>
          不确定改什么就点「修正反向 WS」——它只补这一条，不动其它配置。
        </div>
      </div>`;

    const isOn = (x) => !!x && (x.enable === true || x.enabled === true);
    const arr = (v) => (Array.isArray(v) ? v : []);

    /* 真机的配置是 { network: { websocketServers: [...] }, musicSignUrl: ... }，
     * 老的/裁剪过的版本可能把 network 里那几项平铺在顶层。两种都认：
     * 判断依据是"顶层有没有 network 对象"，没有就当成平铺。 */
    const netOf = (c) => (c.network && typeof c.network === 'object' ? c.network : c);

    function renderSummary(c) {
      const n = netOf(c);
      const wsServers = arr(n.websocketServers);
      const wsOn = wsServers.filter(isOn).map((s) => ':' + (s.port || '?'));
      const wsClients = arr(n.websocketClients).filter(isOn);
      const httpOn = arr(n.httpServers).filter(isOn).map((s) => ':' + (s.port || '?'));
      const httpClients = arr(n.httpClients).filter(isOn);

      $('#nw-ws').textContent = wsOn.length ? wsOn.join(' ') : '未开启';
      $('#nw-wsc').textContent = wsClients.length ? String(wsClients.length) + ' 个' : '无';
      $('#nw-http').textContent = httpOn.length
        ? httpOn.join(' ')
        : httpClients.length
          ? String(httpClients.length) + ' 个客户端'
          : '未开启';
      $('#nw-fmt').textContent =
        n.messagePostFormat || (wsServers[0] && wsServers[0].messagePostFormat) || 'array';

      // 机器人要连的那条反向 WS 有没有开——这是唯一一个"改错了机器人就掉线"的点
      const has3001 = wsServers.some((s) => isOn(s) && Number(s.port) === 3001);
      const hint = $('#nw-hint');
      if (has3001) {
        hint.innerHTML = '反向 WS 3001 已开启，机器人连接正常。';
      } else {
        hint.innerHTML =
          '<span style="color:var(--warn,#d08770)">没有启用 3001 的反向 WS 监听，机器人会一直显示未连接。</span>' +
          '登录成功后服务端会自动补一条；十几秒还没生效，就点下面的「修正反向 WS（:3001）」手动补。';
      }
    }

    function hint(text) {
      const h = $('#nw-hint');
      if (h) h.innerHTML = text;
    }

    async function load() {
      const box = $('#nw-edit');
      if (box) box.style.display = 'none';
      hint('正在查询…');

      // 先看登录状态：未登录时协议端会拒绝 OB11Config
      let st;
      try {
        st = await api('/api/qq/status');
      } catch (e) {
        hint('查询登录状态失败：' + esc(e.message));
        return;
      }
      if (!st.configured) {
        hint('服务端没有配置协议端 WebUI 地址或 token，无法读取网络配置。');
        return;
      }
      if (!st.login || st.offline) {
        hint('需要先登录 QQ。协议端的网络配置接口在未登录时是关闭的，' +
             '请先到 <a href="#/qq">登录</a> 页扫码，登录成功后再回来看这一页。');
        return;
      }

      try {
        const d = await api('/api/qq/network');
        const cfg = (d && d.config) || {};
        asString = !!(d && d.as_string);
        const ta = $('#nw-json');
        if (!ta) return; // 用户已经切走
        renderSummary(cfg);
        ta.value = JSON.stringify(cfg, null, 2);
        if (box) box.style.display = '';
      } catch (e) {
        hint('读取网络配置失败：' + esc(e.message));
      }
    }

    /** 从编辑框解析出对象；失败时提示并返回 null。 */
    function readEditor() {
      const ta = $('#nw-json');
      if (!ta) return null;
      let v;
      try {
        v = JSON.parse(ta.value);
      } catch (e) {
        bad('JSON 语法错误：' + e.message);
        return null;
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        bad('配置必须是一个 JSON 对象');
        return null;
      }
      return v;
    }

    function writeEditor(v) {
      const ta = $('#nw-json');
      if (ta) ta.value = JSON.stringify(v, null, 2);
    }

    /**
     * 确保存在一条启用的反向 WS 监听。
     *
     * 兼容两种历史格式：新的 websocketServers 数组、老的 websocketServer 单对象。
     * 只改这一条，其它字段原样保留——用户手写的 token、host 不能被覆盖。
     */
    function ensureWs(c, port) {
      const n = netOf(c);
      if (n.websocketServer && !Array.isArray(n.websocketServer)) {
        n.websocketServer.enable = true;
        n.websocketServer.enabled = true;
        return;
      }
      const list = Array.isArray(n.websocketServers) ? n.websocketServers : (n.websocketServers = []);
      let hit = list.find((s) => s && Number(s.port) === port);
      if (!hit) {
        hit = {
          name: 'ws',
          enable: true,
          enabled: true,
          host: '0.0.0.0',
          port: port,
          messagePostFormat: 'array',
          token: '',
          debug: false,
          heartInterval: 30000,
          reportSelfMessage: false,
        };
        list.push(hit);
      }
      hit.enable = true;
      hit.enabled = true;
    }

    bindActions(el, {
      'nw-save': async (btn) => {
        const v = readEditor();
        if (!v) return;
        btn.disabled = true;
        try {
          await api('/api/qq/network', {
            method: 'PUT',
            body: { config: v, as_string: asString },
          });
          ok('已保存，协议端正在重启 OneBot 服务');
          renderSummary(v);
        } catch (e) {
          bad(e.message);
        } finally {
          btn.disabled = false;
        }
      },
      'nw-fmt': () => {
        const v = readEditor();
        if (v) {
          writeEditor(v);
          ok('已格式化');
        }
      },
      'nw-reload': () => load(),
      'nw-fix': () => {
        const v = readEditor();
        if (!v) return;
        ensureWs(v, 3001);
        writeEditor(v);
        renderSummary(v);
        ok('已在编辑框里补好 3001 反向 WS，确认后点保存');
      },
    });

    load();
  }

  /* ================= 启动 ================= */

  (async function boot() {
    try {
      const st = await api('/api/auth/status');
      app.user = st.user;
      app.totp = !!st.totp_enabled;
      renderShell();
    } catch (_) {
      renderLogin();
    }
  })();
})();
