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
    settings: { title: '设置', icon: '⚙', view: viewSettings },
    personas: { title: '人格', icon: '✦', view: viewPersonas },
    sessions: { title: '会话', icon: '☰', view: viewSessions },
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
            <input type="text" id="lg-user" value="admin" autocomplete="username">
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
    setTimeout(() => $('#lg-pass') && $('#lg-pass').focus(), 30);
  }

  /* ================= 外壳 ================= */

  function renderShell() {
    root.innerHTML = `
      <div class="shell">
        <aside class="side">
          <div class="brand">qqbot<small>轻量 QQ 机器人</small></div>
          ${Object.entries(ROUTES).map(([k, r]) =>
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
    el.innerHTML = `<div class="page-head"><div><h2>设置</h2>
      <div class="desc">模型接入与触发规则，保存后立即生效</div></div></div>
      <div id="set-body"><div class="empty">加载中…</div></div>`;

    api('/api/settings').then((s) => {
      if (!$('#set-body')) return; // 用户已经切走
      const l = s.llm, b = s.bot, c = s.context;
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
    }).catch(errInto('#set-body'));
  }

  /* ================= 人格 ================= */

  function viewPersonas(el) {
    el.innerHTML = `<div class="page-head">
        <div><h2>人格</h2><div class="desc">系统提示词；格式约束由程序强制追加，不可编辑</div></div>
        <button class="btn ghost" data-act="new">新建人格</button>
      </div>
      <div class="card"><div id="ps-list"><div class="empty">加载中…</div></div></div>
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

  function viewSessions(el) {
    el.innerHTML = `<div class="page-head">
        <div><h2>会话</h2><div class="desc">群聊与私聊的上下文记录</div></div>
      </div>
      <div class="card"><div id="ss-list"><div class="empty">加载中…</div></div></div>
      <div class="card" id="ss-detail" style="display:none">
        <h3 id="ss-detail-title">对话记录</h3>
        <div class="chat" id="ss-chat"></div>
      </div>`;

    const load = async () => {
      const d = await api('/api/sessions');
      if (!$('#ss-list')) return; // 用户已经切走
      const items = d.items || [];
      if (!items.length) {
        $('#ss-list').innerHTML = '<div class="empty">还没有任何会话</div>';
        return;
      }
      $('#ss-list').innerHTML = `
        <table>
          <thead><tr><th>会话</th><th>类型</th><th>消息数</th><th>最后活跃</th><th style="width:150px"></th></tr></thead>
          <tbody>
            ${items.map((s) => `
              <tr>
                <td class="mono">${esc(s.id)}</td>
                <td>${s.kind === 'group' ? '<span class="tag">群聊</span>' : '<span class="tag">私聊</span>'}</td>
                <td class="dim">${fmtInt(s.messages)}</td>
                <td class="dim nowrap">${esc(fmtTime(s.updated_at))}</td>
                <td class="nowrap">
                  <button class="btn ghost sm" data-act="peek" data-id="${esc(s.id)}">查看</button>
                  <button class="btn danger sm" data-act="clear" data-id="${esc(s.id)}">清空</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    };

    bindActions(el, {
      peek: async (btn) => {
        const id = btn.dataset.id;
        $('#ss-detail').style.display = '';
        $('#ss-detail-title').textContent = '对话记录 · ' + id;
        $('#ss-chat').innerHTML = '<div class="empty">加载中…</div>';
        try {
          const d = await api('/api/sessions/messages?id=' + encodeURIComponent(id) + '&limit=100');
          const items = d.items || [];
          if (!items.length) {
            $('#ss-chat').innerHTML = '<div class="empty">这个会话还没有消息</div>';
            return;
          }
          $('#ss-chat').innerHTML = items.map((m) => `
            <div class="bubble ${m.role === 'user' ? 'user' : 'assistant'}">
              ${esc(m.content)}
              <div class="meta">${esc(m.role)} · ${esc(fmtTime(m.created_at))} · ${fmtInt(m.tokens)} tok</div>
            </div>`).join('');
          $('#ss-chat').scrollTop = $('#ss-chat').scrollHeight;
        } catch (e) {
          $('#ss-chat').innerHTML = `<div class="err-inline">${esc(e.message)}</div>`;
        }
      },
      clear: async (btn) => {
        const id = btn.dataset.id;
        if (!confirm(`清空会话 ${id} 的全部上下文？此操作不可撤销。`)) return;
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

    async function loadQr() {
      if (qrBusy || loggedIn) return;
      qrBusy = true;
      const box = $('#qq-qr-box');
      try {
        const d = await api('/api/qq/qrcode', { method: 'POST' });
        if (!box || !d) return;
        qrContent = d.image || '';
        box.innerHTML = qrContent
          ? `<img src="${esc(qrContent)}" alt="登录二维码" width="200" height="200"
                  style="border-radius:8px;background:#fff;padding:6px">`
          : '<span style="color:var(--fg-mute);font-size:12px">协议端未返回二维码</span>';
      } catch (e) {
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

    refresh();
    loadQr();
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
        await loadQr();
      },
      'qq-logout': async (btn) => {
        if (!confirm('退出后机器人会离线，需要重新扫码才能恢复。确定退出？')) return;
        btn.disabled = true;
        try {
          await api('/api/qq/logout', { method: 'POST' });
          ok('已退出登录');
          loggedIn = false;
          setTimeout(refresh, 800);
          loadQr();
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
  /* ================= 协议端（内嵌 NapCat WebUI） ================= */

  /* 为什么是内嵌而不是重画一遍：
   *   协议端除了 OneBot 的几个监听，还有 WebUIConfig、日志流、进程重启、
   *   插件、文件管理……这些是低频运维面，在面板里重画一遍既慢又容易跟版本脱节。
   *   服务端把 /webui 反代过来并注入凭据，这里只要挂个 iframe 就够。
   *
   * 注意：真正的 Authorization 由服务端注入，localStorage 里的 "token"
   * 只是一个占位串，仅用来让 WebUI 认为「已登录」，不会发到协议端生效。 */
  function viewNapcat(el) {
    try {
      if (!localStorage.getItem('token')) {
        localStorage.setItem('token', JSON.stringify('panel-proxy'));
      }
    } catch (_) {
      /* 隐私模式写不进 localStorage 也不影响：凭据在后端加上 */
    }

    el.innerHTML = `
      <div class="page-head">
        <div>
          <h2>协议端</h2>
          <div class="desc">NapCat 原生界面：高级网络配置（HTTP / WS 客户端等）、日志、进程与插件</div>
        </div>
        <button class="btn ghost" data-act="nc-reload">刷新</button>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <iframe id="nc-frame" src="/webui/" title="NapCat WebUI"
                style="display:block;width:100%;height:calc(100vh - 200px);min-height:560px;border:0;background:#fff"></iframe>
      </div>

      <div style="margin-top:12px;font-size:11.5px;color:var(--fg-mute);line-height:1.9">
        这里的改动直接写进协议端配置，保存后 OneBot 服务会重启，面板上的「协议端」会短暂显示未连接。<br>
        只改 OneBot 的监听端口，用左侧「网络」页更快；改 HTTP 客户端、token、上报格式这些再用这一页。
      </div>`;

    bindActions(el, {
      'nc-reload': () => {
        const f = $('#nc-frame');
        if (f) f.src = '/webui/';
      },
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
          保存后协议端会重启 OneBot 服务，本页「协议端」会短暂显示未连接，几秒后自动恢复。<br>
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
