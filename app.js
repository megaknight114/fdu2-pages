const CFG_KEY = "fdu2_web_config_v1";

const busy = {
  health: false,
  venues: false,
  slots: false,
  book: false,
  orders: false,
  cancelOrder: false,
  jobs: false,
  schedule: false,
  cancelJob: false,
};

let pollTimer = null;
let pollTick = 0;

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

function printResult(value) {
  const box = $("bookResult");
  if (!box) return;
  if (typeof value === "string") {
    box.textContent = `[${nowStr()}]\n${value}`;
  } else {
    box.textContent = `[${nowStr()}]\n${JSON.stringify(value, null, 2)}`;
  }
}

function getCfg() {
  return {
    apiBase: $("apiBase").value.trim() || window.location.origin,
    accessToken: $("accessToken").value.trim(),
    username: $("username").value.trim(),
    password: $("password").value,
    autoRefresh: $("autoRefresh").checked,
    refreshMs: parseInt($("refreshMs").value, 10) || 5000,
    campusId: parseInt($("campusId").value, 10) || 2,
    targetDate: $("targetDate").value.trim() || "tomorrow",
    venueName: $("venueName").value.trim() || "杨詠曼楼琴房",
    slotIndex: parseInt($("slotIndex").value, 10) || 0,
    captchaRetries: parseInt($("captchaRetries").value, 10) || 5,
  };
}

function setCfg(cfg) {
  $("apiBase").value = cfg.apiBase || window.location.origin;
  $("accessToken").value = cfg.accessToken || "";
  $("username").value = cfg.username || "";
  $("password").value = cfg.password || "";
  $("autoRefresh").checked = cfg.autoRefresh !== false;
  $("refreshMs").value = String(cfg.refreshMs || 5000);
  $("campusId").value = String(cfg.campusId || 2);
  $("targetDate").value = cfg.targetDate || "tomorrow";
  $("venueName").value = cfg.venueName || "杨詠曼楼琴房";
  $("slotIndex").value = String(cfg.slotIndex || 0);
  $("captchaRetries").value = String(cfg.captchaRetries || 5);
}

function saveCfg() {
  const cfg = getCfg();
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  printResult("配置已保存");
  startPolling();
}

function loadCfg() {
  const raw = localStorage.getItem(CFG_KEY);
  if (!raw) {
    setCfg({ apiBase: window.location.origin, autoRefresh: true, refreshMs: 5000 });
    return;
  }
  try {
    setCfg(JSON.parse(raw));
  } catch (_e) {
    setCfg({ apiBase: window.location.origin, autoRefresh: true, refreshMs: 5000 });
  }
}

function buildUrl(path, query) {
  const cfg = getCfg();
  const base = cfg.apiBase.replace(/\/$/, "");
  const url = new URL(`${base}${path}`);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      url.searchParams.set(k, String(v));
    });
  }
  return url.toString();
}

async function callApi(path, opts = {}) {
  const cfg = getCfg();
  const headers = {};
  if (cfg.accessToken) headers["x-access-token"] = cfg.accessToken;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const detail = typeof payload === "object" && payload ? payload.detail : payload;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}

async function guarded(name, fn) {
  if (busy[name]) return null;
  busy[name] = true;
  try {
    return await fn();
  } finally {
    busy[name] = false;
  }
}

function credentialQuery() {
  const cfg = getCfg();
  return {
    username: cfg.username,
    password: cfg.password,
  };
}

function selectedVenue() {
  const sel = $("venueSelect");
  const venueOrder = parseInt(sel.value, 10) || 1;
  const venueName = sel.options[sel.selectedIndex]?.dataset?.name || "";
  return { venueOrder, venueName };
}

function selectedSlot() {
  const sel = $("slotSelect");
  const slotIndex = parseInt(sel.value, 10) || 0;
  const slotText = sel.options[sel.selectedIndex]?.textContent || "";
  return { slotIndex, slotText };
}

function renderVenues(venues) {
  const sel = $("venueSelect");
  const prev = parseInt(sel.value, 10);
  sel.innerHTML = "";

  if (!venues || !venues.length) {
    const op = document.createElement("option");
    op.value = "";
    op.textContent = "无场馆";
    sel.appendChild(op);
    return;
  }

  venues.forEach((v) => {
    const op = document.createElement("option");
    op.value = String(v.venue_order);
    op.textContent = `#${v.venue_order} ${v.venue_name}`;
    op.dataset.name = v.venue_name || "";
    if (prev && prev === v.venue_order) op.selected = true;
    sel.appendChild(op);
  });
}

function renderSlots(slots) {
  const sel = $("slotSelect");
  const prev = parseInt(sel.value, 10);
  sel.innerHTML = "";

  if (!slots || !slots.length) {
    const op = document.createElement("option");
    op.value = "0";
    op.textContent = "无时段";
    sel.appendChild(op);
    return;
  }

  let firstReservable = null;
  slots.forEach((s) => {
    const op = document.createElement("option");
    op.value = String(s.slot_index);
    const mark = s.reservable ? "可约" : "不可约";
    op.textContent = `[${mark}] #${s.slot_index} ${s.time_text} ${s.venue_text}`.trim();
    if (prev && prev === s.slot_index) op.selected = true;
    if (firstReservable === null && s.reservable) firstReservable = s.slot_index;
    sel.appendChild(op);
  });

  if (!prev && firstReservable !== null) {
    sel.value = String(firstReservable);
  }
}

function escapeHtml(input) {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
      <tr>
        <th>订单号</th><th>类别</th><th>场馆</th><th>日期</th><th>时段</th><th>状态</th><th>操作</th>
      </tr>
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
      const statusClass = j.status === "success" ? "ok" : j.status === "scheduled" ? "ok" : "no";
      const canCancel = j.status === "scheduled";
      const cancelBtn = canCancel
        ? `<button class="btn mini" data-act="cancel-job" data-id="${escapeHtml(j.job_id)}">取消任务</button>`
        : "";
      return `<tr>
        <td>${escapeHtml(j.job_id)}</td>
        <td><span class="tag ${statusClass}">${escapeHtml(j.status)}</span></td>
        <td>${escapeHtml(j.run_at)}</td>
        <td>${escapeHtml(j.request?.target_date || "")}</td>
        <td>${escapeHtml(j.request?.venue_order || "")}</td>
        <td>${escapeHtml(j.request?.slot_index || "0")}</td>
        <td>${cancelBtn}</td>
      </tr>`;
    })
    .join("");

  wrap.innerHTML = `<table>
    <thead>
      <tr>
        <th>任务ID</th><th>状态</th><th>执行时间</th><th>目标日期</th><th>场馆序号</th><th>时段号</th><th>操作</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function checkHealth() {
  return guarded("health", async () => {
    try {
      const data = await callApi("/api/health");
      setLive(true, `Online ${new Date(data.time).toLocaleTimeString()}`);
      return data;
    } catch (e) {
      setLive(false, `Offline: ${e.message}`);
      throw e;
    }
  });
}

async function loadVenues() {
  return guarded("venues", async () => {
    const cfg = getCfg();
    const data = await callApi("/api/venues", {
      query: {
        campus_id: cfg.campusId,
        ...credentialQuery(),
      },
    });
    renderVenues(data.venues || []);
    return data;
  });
}

async function loadSlots() {
  return guarded("slots", async () => {
    const cfg = getCfg();
    const { venueOrder } = selectedVenue();
    const data = await callApi("/api/slots", {
      query: {
        campus_id: cfg.campusId,
        venue_order: venueOrder,
        target_date: cfg.targetDate,
        ...credentialQuery(),
      },
    });
    renderSlots(data.slots || []);
    return data;
  });
}

async function bookOnce() {
  return guarded("book", async () => {
    const cfg = getCfg();
    const { venueOrder, venueName } = selectedVenue();
    const { slotIndex } = selectedSlot();

    const payload = {
      username: cfg.username || null,
      password: cfg.password || null,
      campus_id: cfg.campusId,
      venue_order: venueOrder,
      target_date: cfg.targetDate,
      slot_index: slotIndex,
      venue_name: venueName || cfg.venueName,
      captcha_retries: cfg.captchaRetries,
    };

    const data = await callApi("/api/book", {
      method: "POST",
      body: payload,
    });

    printResult(data);
    await refreshOrders();
    await refreshJobs();
    return data;
  });
}

async function refreshOrders() {
  return guarded("orders", async () => {
    const data = await callApi("/api/orders", {
      query: credentialQuery(),
    });
    renderOrdersTable(data.orders || []);
    return data;
  });
}

async function cancelOrder(orderId) {
  return guarded("cancelOrder", async () => {
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
    const runAt = normalizeRunAt($("runAt").value);
    if (!runAt) {
      throw new Error("请先填写执行时间");
    }

    const cfg = getCfg();
    const { venueOrder, venueName } = selectedVenue();
    const slotIndex = parseInt($("slotIndex").value, 10) || 0;

    const payload = {
      username: cfg.username || null,
      password: cfg.password || null,
      campus_id: cfg.campusId,
      venue_order: venueOrder,
      target_date: cfg.targetDate,
      slot_index: slotIndex,
      venue_name: venueName || cfg.venueName,
      captcha_retries: cfg.captchaRetries,
      run_at: runAt,
    };

    const data = await callApi("/api/jobs/schedule", {
      method: "POST",
      body: payload,
    });

    printResult(data);
    await refreshJobs();
    return data;
  });
}

async function refreshJobs() {
  return guarded("jobs", async () => {
    const data = await callApi("/api/jobs");
    renderJobsTable(data.jobs || []);
    return data;
  });
}

async function cancelJob(jobId) {
  return guarded("cancelJob", async () => {
    const data = await callApi(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    });
    printResult({ cancel_job: jobId, result: data.ok });
    await refreshJobs();
    return data;
  });
}

function attachEvents() {
  $("saveConnBtn").addEventListener("click", () => {
    saveCfg();
  });

  $("healthBtn").addEventListener("click", async () => {
    try {
      await checkHealth();
      printResult("连接正常");
    } catch (e) {
      printResult(`连接失败: ${e.message}`);
    }
  });

  $("loadVenuesBtn").addEventListener("click", async () => {
    try {
      const data = await loadVenues();
      printResult({ venues: data.venues || [] });
      await loadSlots();
    } catch (e) {
      printResult(`刷新场馆失败: ${e.message}`);
    }
  });

  $("loadSlotsBtn").addEventListener("click", async () => {
    try {
      const data = await loadSlots();
      printResult({ target_date: data.target_date, slots: data.slots || [] });
    } catch (e) {
      printResult(`刷新时段失败: ${e.message}`);
    }
  });

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

  $("autoRefresh").addEventListener("change", startPolling);
  $("refreshMs").addEventListener("change", startPolling);
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  const cfg = getCfg();
  if (!cfg.autoRefresh) return;

  const interval = Math.max(1000, cfg.refreshMs || 5000);
  pollTimer = setInterval(async () => {
    pollTick += 1;
    try {
      await checkHealth();
      await refreshJobs();
      if (pollTick % Math.max(1, Math.floor(30000 / interval)) === 0) {
        await refreshOrders();
      }
    } catch (_e) {
      // keep polling even on intermittent failures
    }
  }, interval);
}

async function initialLoad() {
  try {
    await checkHealth();
  } catch (e) {
    printResult(`初始连接失败: ${e.message}`);
  }

  try {
    await loadVenues();
  } catch (_e) {
    // user can retry manually
  }

  try {
    await loadSlots();
  } catch (_e) {
    // user can retry manually
  }

  try {
    await refreshJobs();
  } catch (_e) {
    // user can retry manually
  }

  try {
    await refreshOrders();
  } catch (_e) {
    // user can retry manually
  }
}

async function main() {
  loadCfg();
  attachEvents();
  startPolling();
  await initialLoad();
}

main();
