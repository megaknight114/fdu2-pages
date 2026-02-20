const CFG_KEY = "fdu2_web_config_v4";
const SNAPSHOT_CACHE_KEY = "fdu2_last_good_snapshot_v1";
const INTERNAL_CAMPUS_ID = 2;
const DEFAULT_API_BASE = "https://circus-plenty-sur-keys.trycloudflare.com";

const busy = {
  health: false,
  availabilityRefresh: false,
  availabilityPoll: false,
  availabilityLatest: false,
  book: false,
  orders: false,
  cancelOrder: false,
  jobs: false,
  schedule: false,
  cancelJob: false,
};
const inflight = {};

let pollTimer = null;
let pollTick = 0;
let apiReady = false;
let availabilityList = [];
let availabilityJobId = null;

function $(id) {
  return document.getElementById(id);
}

function nowStr() {
  return new Date().toLocaleString();
}

function setLive(ok, text) {
  const dot = $("liveDot");
  const liveText = $("liveText");
  if (!dot || !liveText) return;
  dot.classList.remove("ok", "bad");
  dot.classList.add(ok ? "ok" : "bad");
  liveText.textContent = text || (ok ? "Online" : "Offline");
}

function setHint(text, kind = "warn") {
  const el = $("connHint");
  if (!el) return;
  el.classList.remove("warn", "ok");
  el.classList.add(kind === "ok" ? "ok" : "warn");
  el.textContent = text;
}

function setAvailabilityProgress(text, state = "idle") {
  const el = $("availabilityProgress");
  const bar = $("availabilityBar");
  const pct = $("availabilityPercent");
  if (!el) return;
  el.classList.remove("running", "ok", "error");
  if (state === "running") el.classList.add("running");
  if (state === "ok") el.classList.add("ok");
  if (state === "error") el.classList.add("error");
  el.textContent = text;
  if (bar && !bar.style.width) bar.style.width = "0%";
  if (pct && !pct.textContent) pct.textContent = "0%";
}

function setAvailabilityPercent(percent) {
  const bar = $("availabilityBar");
  const pct = $("availabilityPercent");
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  if (bar) bar.style.width = `${p}%`;
  if (pct) pct.textContent = `${p}%`;
}

function printResult(value) {
  const box = $("bookResult");
  if (!box) return;
  if (typeof value === "string") {
    box.textContent = `[${nowStr()}]\n${value}`;
  } else {
    box.textContent = `[${nowStr()}]\n${JSON.stringify(value, null, 2)}`;
  }
}

function normalizeBase(raw) {
  return String(raw || "").trim().replace(/\/$/, "");
}

function isGitHubPagesSite() {
  return /github\.io$/i.test(window.location.hostname);
}

function validateApiBase(base) {
  if (!base) return "请先填写 API Base（例如 https://api.example.com）";
  let parsed;
  try {
    parsed = new URL(base);
  } catch (_e) {
    return "API Base 不是合法 URL";
  }
  if (window.location.protocol === "https:" && parsed.protocol !== "https:") {
    return "当前页面是 HTTPS，API Base 也必须是 HTTPS（浏览器会拦截 https->http）";
  }
  if (isGitHubPagesSite() && parsed.hostname.endsWith("github.io")) {
    return "API Base 不能填 GitHub Pages 地址，需要填你的后端服务地址";
  }
  return "";
}

function getCfg() {
  return {
    apiBase: normalizeBase($("apiBase").value),
    accessToken: $("accessToken").value.trim(),
    username: $("username").value.trim(),
    password: $("password").value,
    autoRefresh: $("autoRefresh").checked,
    refreshMs: parseInt($("refreshMs").value, 10) || 5000,
    useParallel: $("useParallel").checked,
    maxWorkers: parseInt($("maxWorkers").value, 10) || 3,
    targetDate: $("targetDate").value.trim() || "tomorrow",
    captchaRetries: parseInt($("captchaRetries").value, 10) || 5,
  };
}

function setCfg(cfg) {
  $("apiBase").value = normalizeBase(cfg.apiBase || "");
  $("accessToken").value = cfg.accessToken || "";
  $("username").value = cfg.username || "";
  $("password").value = cfg.password || "";
  $("autoRefresh").checked = cfg.autoRefresh !== false;
  $("refreshMs").value = String(cfg.refreshMs || 5000);
  $("useParallel").checked = cfg.useParallel !== false;
  $("maxWorkers").value = String(cfg.maxWorkers || 3);
  $("targetDate").value = cfg.targetDate || "tomorrow";
  $("captchaRetries").value = String(cfg.captchaRetries || 5);
}

function saveCfg() {
  const cfg = getCfg();
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  const invalid = validateApiBase(cfg.apiBase);
  if (invalid) {
    apiReady = false;
    setOpsEnabled(false);
    setHint(invalid, "warn");
    setLive(false, "Need valid API Base");
    printResult(`配置已保存，但当前不可用: ${invalid}`);
  } else {
    setHint("配置已保存，点击“测试连接”。", "ok");
    printResult("配置已保存");
  }
  startPolling();
}

function loadCfg() {
  const raw = localStorage.getItem(CFG_KEY);
  if (!raw) {
    setCfg({
      apiBase: DEFAULT_API_BASE,
      autoRefresh: true,
      refreshMs: 5000,
      useParallel: true,
      maxWorkers: 3,
    });
    return;
  }
  try {
    const cfg = JSON.parse(raw);
    if (!cfg.apiBase) cfg.apiBase = DEFAULT_API_BASE;
    if (cfg.captchaRetries === undefined) cfg.captchaRetries = 5;
    setCfg(cfg);
  } catch (_e) {
    setCfg({
      apiBase: DEFAULT_API_BASE,
      autoRefresh: true,
      refreshMs: 5000,
      useParallel: true,
      maxWorkers: 3,
      captchaRetries: 5,
    });
  }
}

function buildUrl(path, query) {
  const cfg = getCfg();
  const invalid = validateApiBase(cfg.apiBase);
  if (invalid) throw new Error(invalid);

  const url = new URL(`${cfg.apiBase}${path}`);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      url.searchParams.set(k, String(v));
    });
  }
  return url.toString();
}

function normalizeApiErrorText(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith("<!DOCTYPE html>") || trimmed.startsWith("<html")) {
    return "API Base 指向了网页而不是后端 API，请检查地址是否正确。";
  }
  if (trimmed.includes("login_failed")) {
    return "登录失败，请检查用户名/密码，或稍后重试。";
  }
  if (trimmed.includes("bootstrap_timeout")) {
    return "登录阶段超时，请稍后重试（系统侧偶发）。";
  }
  if (trimmed.length > 220) return `${trimmed.slice(0, 220)}...`;
  return trimmed;
}

async function callApi(path, opts = {}) {
  const cfg = getCfg();
  const headers = {};
  if (cfg.accessToken) headers["x-access-token"] = cfg.accessToken;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let res;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method || "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    throw new Error(`网络请求失败: ${e.message}`);
  }

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const detail = typeof payload === "object" && payload ? payload.detail : payload;
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    throw new Error(normalizeApiErrorText(text));
  }
  return payload;
}

async function guarded(name, fn) {
  if (inflight[name]) return inflight[name];
  inflight[name] = (async () => {
    busy[name] = true;
    try {
      return await fn();
    } finally {
      busy[name] = false;
      inflight[name] = null;
    }
  })();
  return inflight[name];
}

function credentialQuery() {
  const cfg = getCfg();
  return { username: cfg.username, password: cfg.password };
}

function setOpsEnabled(enabled) {
  [
    "refreshAvailabilityBtn",
    "bookBtn",
    "refreshOrdersBtn",
    "scheduleBtn",
    "venueSelect",
    "slotSelect",
  ].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !enabled;
  });
}

function getFeasibleVenues() {
  return availabilityList.filter(
    (v) => !v.error && Number(v.reservable_count || 0) > 0,
  );
}

function countFeasibleFromSnapshot(snapshot) {
  const venues = snapshot?.venues || [];
  return venues.filter((v) => !v.error && Number(v.reservable_count || 0) > 0).length;
}

function saveGoodSnapshot(snapshot) {
  if (!snapshot || countFeasibleFromSnapshot(snapshot) <= 0) return;
  const payload = {
    saved_at: new Date().toISOString(),
    snapshot,
  };
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(payload));
}

function loadCachedSnapshot(targetDate) {
  const raw = localStorage.getItem(SNAPSHOT_CACHE_KEY);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    const snapshot = payload?.snapshot;
    if (!snapshot) return null;

    const q = String(targetDate || "").toLowerCase();
    if (q) {
      const td = String(snapshot?.target_date || "").toLowerCase();
      const rd = String(snapshot?.resolved_target_date || "").toLowerCase();
      if (td && td !== q && rd && rd !== q) return null;
    }
    return snapshot;
  } catch (_e) {
    return null;
  }
}

function findVenueByName(name) {
  return availabilityList.find((v) => v.venue_name === name) || null;
}

function updateScheduleSelected() {
  const el = $("scheduleSelected");
  if (!el) return;
  const venueName = $("venueSelect")?.value || "-";
  const slotText = $("slotSelect")?.selectedOptions?.[0]?.textContent || "-";
  el.textContent = `场馆: ${venueName} | 时段: ${slotText}`;
}

function populateVenueSelect() {
  const sel = $("venueSelect");
  const prev = sel.value;
  sel.innerHTML = "";

  const feasible = getFeasibleVenues();
  if (!feasible.length) {
    const op = document.createElement("option");
    op.value = "";
    op.textContent = "暂无可预约场馆";
    sel.appendChild(op);
    populateSlotSelect();
    return;
  }

  feasible.forEach((v) => {
    const op = document.createElement("option");
    op.value = v.venue_name;
    op.textContent = `${v.venue_name} (${v.reservable_count || 0})`;
    if (prev && prev === v.venue_name) op.selected = true;
    sel.appendChild(op);
  });

  if (!sel.value) sel.value = feasible[0].venue_name;
  populateSlotSelect();
}

function populateSlotSelect() {
  const sel = $("slotSelect");
  const venueName = $("venueSelect").value;
  const venue = findVenueByName(venueName);
  sel.innerHTML = "";

  if (!venue || !venue.reservable_slots || !venue.reservable_slots.length) {
    const op = document.createElement("option");
    op.value = "0";
    op.textContent = "无可预约时段";
    sel.appendChild(op);
    updateScheduleSelected();
    return;
  }

  venue.reservable_slots.forEach((s, idx) => {
    const op = document.createElement("option");
    op.value = String(s.slot_index);
    op.textContent = `#${s.slot_index} ${s.time_text}`;
    if (idx === 0) op.selected = true;
    sel.appendChild(op);
  });
  updateScheduleSelected();
}

function escapeHtml(input) {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderAvailabilityTable(snapshot) {
  const wrap = $("availabilityWrap");
  const meta = $("availabilityMeta");
  const resolvedDate = snapshot?.resolved_target_date || "";
  const venues = snapshot?.venues || [];
  const stats = snapshot?.stats || {};

  meta.textContent = `日期: ${resolvedDate || "-"} | 场馆: ${venues.length} | 成功: ${stats.success ?? "-"} | 失败: ${stats.failed ?? "-"}`;

  if (!venues.length) {
    wrap.innerHTML = `<div style="padding:10px;color:#5b564d;">暂无数据</div>`;
    return;
  }

  const rows = venues
    .map((v) => {
      const slots = (v.reservable_slots || []).map((s) => s.time_text).filter(Boolean);
      const chips = slots.length
        ? slots.map((t) => `<span class="slot-chip">${escapeHtml(t)}</span>`).join("")
        : "<span class='muted'>无</span>";

      let status = `<span class="tag no">无可约</span>`;
      if (v.state === "pending") status = `<span class="tag">抓取中</span>`;
      else if (v.error) status = `<span class="tag no">失败</span>`;
      else if (Number(v.reservable_count || 0) > 0) {
        status = `<span class="tag ok">${v.reservable_count || 0} 可约</span>`;
      }

      return `<tr>
        <td>${escapeHtml(v.venue_name)}</td>
        <td>${status}</td>
        <td>${chips}</td>
      </tr>`;
    })
    .join("");

  wrap.innerHTML = `<table>
    <thead>
      <tr><th>场馆名</th><th>状态</th><th>可预约时段</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function applyAvailabilitySnapshot(snapshot, opts = {}) {
  const cfg = getCfg();
  const fallbackToCache = opts.fallbackToCache !== false;
  const normalized = snapshot
    ? { ...snapshot, target_date: snapshot.target_date || cfg.targetDate }
    : null;
  const hasFeasible = countFeasibleFromSnapshot(normalized) > 0;

  if (hasFeasible) {
    availabilityList = normalized.venues || [];
    saveGoodSnapshot(normalized);
    renderAvailabilityTable(normalized);
    populateVenueSelect();
    return { source: "live", hasFeasible: true };
  }

  if (fallbackToCache) {
    const cached = loadCachedSnapshot(cfg.targetDate);
    if (cached && countFeasibleFromSnapshot(cached) > 0) {
      availabilityList = cached.venues || [];
      renderAvailabilityTable(cached);
      populateVenueSelect();
      return { source: "cache", hasFeasible: true };
    }
  }

  availabilityList = normalized?.venues || [];
  renderAvailabilityTable(normalized || { venues: [] });
  populateVenueSelect();
  return { source: "live", hasFeasible: false };
}

function renderOrdersTable(orders) {
  const wrap = $("ordersWrap");
  if (!orders || !orders.length) {
    wrap.innerHTML = `<div style="padding:10px;color:#5b564d;">暂无订单</div>`;
    return;
  }

  const rows = orders
    .map((o) => {
      const cancelBtn = o.cancelable
        ? `<button class="btn danger mini" data-act="cancel-order" data-id="${escapeHtml(o.order_id)}">撤销</button>`
        : "";
      return `<tr>
        <td>${escapeHtml(o.order_id)}</td>
        <td>${escapeHtml(o.category)}</td>
        <td>${escapeHtml(o.venue_name)}</td>
        <td>${escapeHtml(o.order_date)}</td>
        <td>${escapeHtml(o.time_slot)}</td>
        <td>${escapeHtml(o.status)}</td>
        <td>${cancelBtn}</td>
      </tr>`;
    })
    .join("");

  wrap.innerHTML = `<table>
    <thead>
      <tr><th>订单号</th><th>类别</th><th>场馆</th><th>日期</th><th>时段</th><th>状态</th><th>操作</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderJobsTable(jobs) {
  const wrap = $("jobsWrap");
  if (!jobs || !jobs.length) {
    wrap.innerHTML = `<div style="padding:10px;color:#5b564d;">暂无任务</div>`;
    return;
  }

  const rows = jobs
    .map((j) => {
      const statusClass = j.status === "success" || j.status === "scheduled" ? "ok" : "no";
      const canCancel = j.status === "scheduled";
      const cancelBtn = canCancel
        ? `<button class="btn mini" data-act="cancel-job" data-id="${escapeHtml(j.job_id)}">取消任务</button>`
        : "";
      return `<tr>
        <td>${escapeHtml(j.job_id)}</td>
        <td><span class="tag ${statusClass}">${escapeHtml(j.status)}</span></td>
        <td>${escapeHtml(j.run_at)}</td>
        <td>${escapeHtml(j.request?.target_date || "")}</td>
        <td>${escapeHtml(j.request?.venue_name || "")}</td>
        <td>${escapeHtml(j.request?.slot_index || "0")}</td>
        <td>${cancelBtn}</td>
      </tr>`;
    })
    .join("");

  wrap.innerHTML = `<table>
    <thead>
      <tr><th>任务ID</th><th>状态</th><th>执行时间</th><th>目标日期</th><th>场馆名</th><th>时段号</th><th>操作</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function checkHealth() {
  return guarded("health", async () => {
    try {
      const cfg = getCfg();
      const invalid = validateApiBase(cfg.apiBase);
      if (invalid) throw new Error(invalid);
      const data = await callApi("/api/health");
      apiReady = true;
      setOpsEnabled(true);
      setHint(`后端连接正常: ${cfg.apiBase}`, "ok");
      setLive(true, `Online ${new Date(data.time).toLocaleTimeString()}`);
      return data;
    } catch (e) {
      apiReady = false;
      setOpsEnabled(false);
      setHint(`连接不可用: ${e.message}`, "warn");
      setLive(false, `Offline: ${e.message}`);
      throw e;
    }
  });
}

async function loadLatestAvailability() {
  return guarded("availabilityLatest", async () => {
    if (!apiReady) throw new Error("后端未连通，请先测试连接");
    const cfg = getCfg();
    const data = await callApi("/api/availability", {
      query: { target_date: cfg.targetDate },
    });
    const snapshot = data?.snapshot || null;
    if (snapshot) {
      const applied = applyAvailabilitySnapshot(snapshot, { fallbackToCache: true });
      if (applied.source === "cache") {
        setAvailabilityProgress("当前结果不可用，已回退到最近成功快照", "ok");
      }
      return snapshot;
    }
    const cached = loadCachedSnapshot(cfg.targetDate);
    if (cached) {
      applyAvailabilitySnapshot(cached, { fallbackToCache: false });
      setAvailabilityProgress("无新结果，使用本地缓存快照", "ok");
      return cached;
    }
    return null;
  });
}

function isTerminalStatus(status) {
  return ["success", "partial_success", "failed"].includes(status);
}

async function pollAvailabilityJob(jobId) {
  return guarded("availabilityPoll", async () => {
    if (!jobId) return null;
    const data = await callApi(`/api/availability/refresh/${encodeURIComponent(jobId)}`);
    const job = data?.job;
    if (!job) return null;

    const p = job.progress || {};
    const done = Number(p.done || 0);
    const total = Number(p.total || 0);
    const success = Number(p.success || 0);
    const failed = Number(p.failed || 0);
    const percent = total > 0 ? Math.round((done * 100) / total) : 0;

    setAvailabilityProgress(
      `刷新中 ${done}/${total} | 成功 ${success} | 失败 ${failed}`,
      "running",
    );
    setAvailabilityPercent(percent);

    const partialSnapshot = {
      resolved_target_date: job?.params?.resolved_target_date || "",
      venues: job.venues || [],
      stats: {
        total,
        success,
        failed,
      },
    };
    if ((partialSnapshot.venues || []).length) {
      const applied = applyAvailabilitySnapshot(partialSnapshot, { fallbackToCache: false });
      if (!applied.hasFeasible) {
        const cached = loadCachedSnapshot(getCfg().targetDate);
        if (cached) {
          applyAvailabilitySnapshot(cached, { fallbackToCache: false });
        }
      }
    }

    if (isTerminalStatus(job.status)) {
      availabilityJobId = null;
      if (job.snapshot) {
        const applied = applyAvailabilitySnapshot(job.snapshot, { fallbackToCache: true });
        if (job.status === "success") {
          setAvailabilityProgress("刷新完成", "ok");
          setAvailabilityPercent(100);
        } else if (job.status === "partial_success") {
          if (applied.source === "cache") {
            setAvailabilityProgress("部分成功，但无可用项；已回退到缓存可选项", "ok");
          } else {
            setAvailabilityProgress("部分成功，可用项已更新", "ok");
          }
          setAvailabilityPercent(100);
        } else {
          if (applied.source === "cache") {
            setAvailabilityProgress("刷新失败，已回退到最近成功快照", "error");
          } else {
            setAvailabilityProgress(`刷新失败: ${job.error || "unknown"}`, "error");
          }
        }
      } else if (job.status === "failed") {
        const cached = loadCachedSnapshot(getCfg().targetDate);
        if (cached) {
          applyAvailabilitySnapshot(cached, { fallbackToCache: false });
          setAvailabilityProgress("刷新失败，已回退到最近成功快照", "error");
        } else {
          setAvailabilityProgress(`刷新失败: ${job.error || "unknown"}`, "error");
        }
      }
    }

    return job;
  });
}

async function startAvailabilityRefresh() {
  return guarded("availabilityRefresh", async () => {
    if (!apiReady) throw new Error("后端未连通，请先测试连接");
    const cfg = getCfg();

    const payload = {
      username: cfg.username || null,
      password: cfg.password || null,
      campus_id: INTERNAL_CAMPUS_ID,
      target_date: cfg.targetDate,
      parallel: cfg.useParallel,
      max_workers: cfg.maxWorkers,
    };

    const btn = $("refreshAvailabilityBtn");
    if (btn) btn.disabled = true;
    setAvailabilityProgress("已提交刷新任务，准备抓取...", "running");
    setAvailabilityPercent(0);

    try {
      const data = await callApi("/api/availability/refresh", {
        method: "POST",
        body: payload,
      });
      availabilityJobId = data?.job?.job_id || null;
      await pollAvailabilityJob(availabilityJobId);
      return data;
    } finally {
      if (btn) btn.disabled = !apiReady;
    }
  });
}

async function bookOnce() {
  return guarded("book", async () => {
    if (!apiReady) throw new Error("后端未连通，请先测试连接");

    const cfg = getCfg();
    const venueName = $("venueSelect").value;
    const venue = findVenueByName(venueName);
    if (!venue) throw new Error("请先刷新总览并选择可预约场馆");

    const slotIndex = parseInt($("slotSelect").value, 10) || 0;
    if (!(slotIndex > 0)) throw new Error("请先选择可预约时段");

    const payload = {
      username: cfg.username || null,
      password: cfg.password || null,
      campus_id: INTERNAL_CAMPUS_ID,
      venue_order: venue.venue_order,
      target_date: cfg.targetDate,
      slot_index: slotIndex,
      venue_name: venue.venue_name,
      captcha_retries: cfg.captchaRetries,
    };

    const data = await callApi("/api/book", { method: "POST", body: payload });
    printResult(data);
    await Promise.all([refreshOrders(), refreshJobs(), loadLatestAvailability()]);
    return data;
  });
}

async function refreshOrders() {
  return guarded("orders", async () => {
    if (!apiReady) throw new Error("后端未连通，请先测试连接");
    const data = await callApi("/api/orders", { query: credentialQuery() });
    renderOrdersTable(data.orders || []);
    return data;
  });
}

async function cancelOrder(orderId) {
  return guarded("cancelOrder", async () => {
    if (!apiReady) throw new Error("后端未连通，请先测试连接");
    const cfg = getCfg();
    const data = await callApi("/api/orders/cancel", {
      method: "POST",
      body: {
        order_id: orderId,
        username: cfg.username || null,
        password: cfg.password || null,
      },
    });
    renderOrdersTable(data.orders || []);
    printResult({ cancel_order: orderId, message: data.message || "ok" });
    return data;
  });
}

function normalizeRunAt(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return `${value}:00`;
  return value;
}

async function scheduleJob() {
  return guarded("schedule", async () => {
    if (!apiReady) throw new Error("后端未连通，请先测试连接");

    const runAt = normalizeRunAt($("runAt").value);
    if (!runAt) throw new Error("请先填写执行时间");

    const cfg = getCfg();
    const venueName = $("venueSelect").value;
    const venue = findVenueByName(venueName);
    if (!venue) throw new Error("请先从可行列表中选择场馆");

    const slotIndex = parseInt($("slotSelect").value, 10) || 0;
    if (!(slotIndex > 0)) throw new Error("请先从可行列表中选择时段");

    const payload = {
      username: cfg.username || null,
      password: cfg.password || null,
      campus_id: INTERNAL_CAMPUS_ID,
      venue_order: venue.venue_order,
      target_date: cfg.targetDate,
      slot_index: slotIndex,
      venue_name: venue.venue_name,
      captcha_retries: cfg.captchaRetries,
      run_at: runAt,
    };

    const data = await callApi("/api/jobs/schedule", { method: "POST", body: payload });
    printResult(data);
    await refreshJobs();
    return data;
  });
}

async function refreshJobs() {
  return guarded("jobs", async () => {
    if (!apiReady) throw new Error("后端未连通，请先测试连接");
    const data = await callApi("/api/jobs");
    renderJobsTable(data.jobs || []);
    return data;
  });
}

async function cancelJob(jobId) {
  return guarded("cancelJob", async () => {
    if (!apiReady) throw new Error("后端未连通，请先测试连接");
    const data = await callApi(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    });
    printResult({ cancel_job: jobId, result: data.ok });
    await refreshJobs();
    return data;
  });
}

function attachEvents() {
  $("saveConnBtn").addEventListener("click", saveCfg);

  $("healthBtn").addEventListener("click", async () => {
    try {
      await checkHealth();
      printResult("连接正常");
    } catch (e) {
      printResult(`连接失败: ${e.message}`);
    }
  });

  $("refreshAvailabilityBtn").addEventListener("click", async () => {
    try {
      const result = await startAvailabilityRefresh();
      printResult({
        refresh_job_id: result?.job?.job_id,
        reused: result?.reused,
      });
    } catch (e) {
      setAvailabilityProgress(`刷新失败: ${e.message}`, "error");
      printResult(`刷新总览失败: ${e.message}`);
    }
  });

  $("venueSelect").addEventListener("change", populateSlotSelect);
  $("slotSelect").addEventListener("change", updateScheduleSelected);

  $("bookBtn").addEventListener("click", async () => {
    try {
      await bookOnce();
    } catch (e) {
      printResult(`预约失败: ${e.message}`);
    }
  });

  $("refreshOrdersBtn").addEventListener("click", async () => {
    try {
      await refreshOrders();
      printResult("订单已刷新");
    } catch (e) {
      printResult(`刷新订单失败: ${e.message}`);
    }
  });

  $("scheduleBtn").addEventListener("click", async () => {
    try {
      await scheduleJob();
    } catch (e) {
      printResult(`创建定时失败: ${e.message}`);
    }
  });

  $("ordersWrap").addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-act='cancel-order']");
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;

    btn.disabled = true;
    try {
      await cancelOrder(id);
    } catch (e) {
      printResult(`撤销失败: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  $("jobsWrap").addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-act='cancel-job']");
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;

    btn.disabled = true;
    try {
      await cancelJob(id);
    } catch (e) {
      printResult(`取消任务失败: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  ["autoRefresh", "refreshMs", "useParallel", "maxWorkers", "targetDate"].forEach((id) => {
    $(id).addEventListener("change", startPolling);
  });

  $("apiBase").addEventListener("change", () => {
    const invalid = validateApiBase(getCfg().apiBase);
    if (invalid) {
      apiReady = false;
      setOpsEnabled(false);
      setHint(invalid, "warn");
      setLive(false, "Need valid API Base");
    }
  });
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  const cfg = getCfg();
  const invalid = validateApiBase(cfg.apiBase);
  if (!cfg.autoRefresh || invalid) return;

  const interval = Math.max(1000, cfg.refreshMs || 5000);
  pollTimer = setInterval(async () => {
    pollTick += 1;
    try {
      await checkHealth();
      if (!apiReady) return;

      if (availabilityJobId) {
        await pollAvailabilityJob(availabilityJobId);
      } else {
        await loadLatestAvailability();
      }

      await refreshJobs();
      if (pollTick % Math.max(1, Math.floor(30000 / interval)) === 0) {
        await refreshOrders();
      }
    } catch (_e) {
      // keep polling
    }
  }, interval);
}

async function initialLoad() {
  const cfg = getCfg();
  const invalid = validateApiBase(cfg.apiBase);
  if (invalid) {
    apiReady = false;
    setOpsEnabled(false);
    setHint(invalid, "warn");
    setLive(false, "Need API Base");
    printResult(`请先修正连接配置: ${invalid}`);
    return;
  }

  try {
    await checkHealth();
  } catch (e) {
    printResult(`初始连接失败: ${e.message}`);
    return;
  }

  try {
    const latest = await loadLatestAvailability();
    if (!latest) {
      await startAvailabilityRefresh();
    } else if (countFeasibleFromSnapshot(latest) > 0) {
      setAvailabilityProgress("已加载最近总览", "ok");
      setAvailabilityPercent(100);
    }
    await Promise.all([refreshJobs(), refreshOrders()]);
  } catch (_e) {
    // user can retry manually
  }
}

async function main() {
  loadCfg();
  attachEvents();
  setOpsEnabled(false);
  setAvailabilityProgress("待刷新");
  setAvailabilityPercent(0);
  updateScheduleSelected();
  startPolling();
  await initialLoad();
}

main();
