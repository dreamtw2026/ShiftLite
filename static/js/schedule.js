/* 轻排班 · 排班页交互：新增/编辑/删除班次、冲突定位与筛选、保存反馈 */
(function () {
  "use strict";

  var dlg = document.getElementById("shift-dialog");
  if (!dlg) return;

  var form = document.getElementById("shift-form");
  var fields = {
    id: document.getElementById("sf-id"),
    employee: document.getElementById("sf-employee"),
    date: document.getElementById("sf-date"),
    template: document.getElementById("sf-template"),
    start: document.getElementById("sf-start"),
    end: document.getElementById("sf-end"),
    brk: document.getElementById("sf-break"),
    position: document.getElementById("sf-position"),
    note: document.getElementById("sf-note"),
    title: document.getElementById("sf-title"),
    deleteBtn: document.getElementById("sf-delete"),
    forceBtn: document.getElementById("sf-force"),
    submitBtn: document.getElementById("sf-submit")
  };
  var conflictBox = document.getElementById("sf-conflicts");
  var conflictList = document.getElementById("sf-conflict-list");
  var errorBox = document.getElementById("sf-errors");
  var modeBadge = document.getElementById("sf-mode-icon");
  var summaryEl = document.getElementById("sf-summary");
  var pendingPayload = null;
  var forceOnce = false;
  var saving = false;
  var mode = "add"; // "add" | "edit"
  var motionOK = !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var TEMPLATES = window.SHIFTLITE_TEMPLATES || [];

  /* ---------- 图标：与 _macros.html 同一套 24×24 线性路径，跟随 currentColor ---------- */
  var ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<polyline points="20 6.5 9.5 17 4 11.5"/>',
    edit: '<path d="M4.5 19.5h3.2L19 8.2a2.26 2.26 0 0 0-3.2-3.2L4.5 16.3z"/><path d="m13.6 7.2 3.2 3.2"/>',
    trash: '<path d="M4.5 6.8h15"/><path d="M9.3 6.5V5.2A1.7 1.7 0 0 1 11 3.5h2a1.7 1.7 0 0 1 1.7 1.7v1.3"/><path d="m6.3 6.8.7 12a2 2 0 0 0 2 1.9h6a2 2 0 0 0 2-1.9l.7-12"/><path d="M10 10.5v6M14 10.5v6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M3.5 20c0-3.1 2.4-5.2 5.5-5.2s5.5 2.1 5.5 5.2"/><path d="M15.5 4.9a3.5 3.5 0 0 1 0 6.2"/><path d="M17.5 15.2c2 .7 3.3 2.4 3.3 4.8"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4"/><path d="M3.5 10h17"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 1.8"/>',
    alert: '<path d="M10.4 4.2 3.2 17.4a1.9 1.9 0 0 0 1.7 2.8h14.2a1.9 1.9 0 0 0 1.7-2.8L13.6 4.2a1.9 1.9 0 0 0-3.2 0z"/><path d="M12 9.2v4"/><circle cx="12" cy="16.4" r="0.7" fill="currentColor" stroke="none"/>',
    xcircle: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
  };

  function iconSVG(name) {
    return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  var SEP = '<span class="sep" aria-hidden="true">·</span>';

  function setBtnContent(btn, iconName, text) {
    btn.innerHTML = iconSVG(iconName) + "<span>" + text + "</span>";
  }

  function modeSubmitIcon() { return mode === "edit" ? "check" : "plus"; }
  function modeSubmitText() { return mode === "edit" ? "保存" : "添加"; }

  /* ---------- 模式切换：图标、按钮、删除可见性、摘要一次性同步 ---------- */
  function setMode(next, data) {
    mode = next;
    var isEdit = next === "edit";
    modeBadge.innerHTML = iconSVG(isEdit ? "edit" : "plus");
    modeBadge.classList.toggle("is-edit", isEdit);
    fields.title.textContent = isEdit ? "调整班次" : "新增班次";
    setBtnContent(fields.submitBtn, modeSubmitIcon(), modeSubmitText());
    fields.deleteBtn.style.display = isEdit ? "inline-flex" : "none";
    if (isEdit && data) {
      summaryEl.hidden = false;
      summaryEl.innerHTML =
        iconSVG("users") + "<span>" + escapeHTML(data.employee_name || "") + "</span>" + SEP +
        iconSVG("calendar") + "<span>" + escapeHTML(data.work_date || "") + "</span>" + SEP +
        iconSVG("clock") + "<span>" + escapeHTML((data.start_time || "") + "–" + (data.end_time || "")) + "</span>";
    } else {
      summaryEl.hidden = true;
      summaryEl.innerHTML = "";
    }
  }

  function severityIcon(sev) {
    return iconSVG(sev === "error" ? "xcircle" : "alert");
  }

  function showConflicts(conflicts) {
    conflictList.innerHTML = "";
    (conflicts || []).forEach(function (c) {
      var li = document.createElement("li");
      li.className = "sev-" + c.severity;
      li.innerHTML = (c.severity === "error" ? iconSVG("xcircle") : iconSVG("alert")) + "<span><b>" +
        (c.rule_label || c.rule) + "：</b>" + c.message + "</span>";
      conflictList.appendChild(li);
    });
    var hasError = (conflicts || []).some(function (c) { return c.severity === "error"; });
    conflictBox.style.display = conflicts && conflicts.length ? "block" : "none";
    fields.forceBtn.style.display = hasError ? "inline-flex" : "none";
    if (hasError) {
      setBtnContent(fields.submitBtn, "edit", "返回修改"); // 提示回去改时间，而非继续提交
    } else {
      setBtnContent(fields.submitBtn, modeSubmitIcon(), modeSubmitText());
    }
  }

  function resetDialog() {
    form.reset();
    fields.id.value = "";
    pendingPayload = null;
    forceOnce = false;
    saving = false;
    conflictBox.style.display = "none";
    conflictList.innerHTML = "";
    errorBox.style.display = "none";
    errorBox.textContent = "";
    fields.forceBtn.style.display = "none";
    [fields.submitBtn, fields.forceBtn, fields.deleteBtn].forEach(function (b) {
      if (!b) return;
      b.disabled = false;
      b.classList.remove("loading");
    });
    setMode("add"); // 先恢复新增外观；编辑入口随后覆盖为编辑模式
  }

  function applyTemplate(tplId) {
    var tpl = TEMPLATES.find(function (t) { return String(t.id) === String(tplId); });
    if (!tpl) return;
    fields.start.value = tpl.start_time;
    fields.end.value = tpl.end_time;
    fields.brk.value = tpl.break_minutes;
    if (tpl.position && !fields.position.value) fields.position.value = tpl.position;
  }

  /* ---------- 冲突定位：滚动到目标班次并短暂高亮（移动端卡片优先，桌面回退网格芯片） ---------- */
  function locateShift(id) {
    var el = document.getElementById("m-shift-" + id);
    if (!el) {
      el = document.getElementById("shift-" + id);
      if (!el) return false;
      el.scrollIntoView({
        behavior: motionOK ? "smooth" : "auto",
        block: "center", inline: "center" });
    } else {
      el.scrollIntoView({
        behavior: motionOK ? "smooth" : "auto",
        block: "center" });
    }
    el.classList.remove("locating");
    void el.offsetWidth; // 重启动画
    el.classList.add("locating");
    window.setTimeout(function () { el.classList.remove("locating"); }, 1600);
    return true;
  }
  window.locateShift = locateShift;

  // 冲突提示点击/键盘定位（事件委托，覆盖面板内全部条目）
  document.addEventListener("click", function (ev) {
    var item = ev.target.closest && ev.target.closest("[data-locate]");
    if (item) locateShift(item.getAttribute("data-locate"));
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    var item = ev.target && ev.target.closest && ev.target.closest("[data-locate]");
    if (item) { ev.preventDefault(); locateShift(item.getAttribute("data-locate")); }
  });

  // 错误 / 提示 筛选折叠
  var conflictFilters = { error: true, warning: true };
  Array.prototype.forEach.call(document.querySelectorAll("[data-conflict-filter]"), function (btn) {
    btn.addEventListener("click", function () {
      var sev = btn.getAttribute("data-conflict-filter");
      conflictFilters[sev] = !conflictFilters[sev];
      btn.setAttribute("aria-pressed", conflictFilters[sev] ? "true" : "false");
      Array.prototype.forEach.call(document.querySelectorAll(".conflict-list [data-severity]"), function (item) {
        item.style.display = conflictFilters[item.getAttribute("data-severity")] ? "" : "none";
      });
    });
  });

  // 页面加载：?focus= 定位冲突班次；保存回跳后高亮刚保存的班次
  var params = new URLSearchParams(window.location.search);
  var focusId = params.get("focus");
  if (focusId) window.setTimeout(function () { locateShift(focusId); }, 250);
  var highlight = null;
  try { highlight = window.sessionStorage.getItem("shiftlite-highlight"); } catch (e) {}
  if (highlight) {
    try { window.sessionStorage.removeItem("shiftlite-highlight"); } catch (e) {}
    window.setTimeout(function () { locateShift(highlight); }, 350);
  }

  // 点击空白格 → 新增班次
  window.openShiftDialogForCell = function (employeeId, dateText, employeeName) {
    resetDialog(); // 已恢复为新增模式（＋徽标、＋添加、隐藏删除与摘要）
    fields.employee.value = String(employeeId);
    fields.date.value = dateText;
    document.getElementById("sf-employee-name").textContent = employeeName || "";
    dlg.showModal();
    fields.employee.focus(); // 聚焦第一个必填字段
  };

  // 点击班次芯片 → 编辑
  window.openShiftDialogForEdit = function (data) {
    resetDialog();
    setMode("edit", data); // ✎徽标、✓保存、显示删除与摘要
    fields.id.value = data.id;
    fields.employee.value = String(data.employee_id);
    fields.date.value = data.work_date;
    fields.template.value = data.template_id ? String(data.template_id) : "";
    fields.start.value = data.start_time;
    fields.end.value = data.end_time;
    fields.brk.value = data.break_minutes;
    fields.position.value = data.position || "";
    fields.note.value = data.note || "";
    document.getElementById("sf-employee-name").textContent = data.employee_name || "";
    dlg.showModal();
    fields.start.focus();
  };

  fields.template.addEventListener("change", function () {
    applyTemplate(fields.template.value);
  });

  // 冲突确认只对检测时的表单快照有效；字段改变后必须重新检测。
  form.addEventListener("input", function () {
    if (!pendingPayload) return;
    pendingPayload = null;
    conflictBox.style.display = "none";
    fields.forceBtn.style.display = "none";
    setBtnContent(fields.submitBtn, modeSubmitIcon(), modeSubmitText());
  });

  function setSaving(on) {
    saving = on;
    [fields.submitBtn, fields.forceBtn, fields.deleteBtn].forEach(function (b) {
      if (!b) return;
      b.disabled = on;
      b.classList.remove("loading");
    });
    if (on) (fields.forceBtn.style.display === "inline-flex" ? fields.forceBtn : fields.submitBtn).classList.add("loading");
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (saving) return; // 防重复提交
    errorBox.style.display = "none";
    var payload = {
      employee_id: fields.employee.value,
      work_date: fields.date.value,
      template_id: fields.template.value || null,
      start_time: fields.start.value,
      end_time: fields.end.value,
      break_minutes: fields.brk.value || 0,
      position: fields.position.value,
      note: fields.note.value
    };
    var isEdit = !!fields.id.value;
    var url = isEdit ? "/api/schedules/" + fields.id.value : "/api/schedules";
    if (forceOnce) { url += "?force=1"; forceOnce = false; }
    pendingPayload = null;
    setSaving(true);
    fetchJSON(url, {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.status === 201 || res.status === 200) {
        try { if (res.data.id) window.sessionStorage.setItem("shiftlite-highlight", String(res.data.id)); } catch (e) {}
        var warnings = (res.data.conflicts || []).filter(function (c) { return c.severity === "warning"; });
        if (warnings.length) {
          window.showToast("已保存，但存在 " + warnings.length + " 条工时提示，请查看冲突面板。", "warning");
        } else {
          window.showToast(isEdit ? "班次已更新。" : "班次已添加。", "success");
        }
        setTimeout(function () { window.location.reload(); }, 650);
      } else if (res.status === 409) {
        showConflicts(res.data.conflicts || []);
        pendingPayload = payload;
        setSaving(false);
      } else if (res.status === 400) {
        errorBox.textContent = (res.data.errors || ["输入有误"]).join("；");
        errorBox.style.display = "block";
        setSaving(false);
      } else {
        errorBox.textContent = "保存失败，请稍后重试。";
        errorBox.style.display = "block";
        setSaving(false);
      }
    }).catch(function () {
      errorBox.textContent = "网络异常，保存失败。";
      errorBox.style.display = "block";
      setSaving(false);
    });
  });

  // 冲突确认：仍要保存
  fields.forceBtn.addEventListener("click", function () {
    if (!pendingPayload || saving) return;
    var isEdit = !!fields.id.value;
    var url = isEdit ? "/api/schedules/" + fields.id.value + "?force=1" : "/api/schedules?force=1";
    setSaving(true);
    fetchJSON(url, {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pendingPayload)
    }).then(function (res) {
      if (res.status === 201 || res.status === 200) {
        try { if (res.data.id) window.sessionStorage.setItem("shiftlite-highlight", String(res.data.id)); } catch (e) {}
        window.showToast("已确认冲突并保存。", "warning");
        setTimeout(function () { window.location.reload(); }, 650);
      } else {
        window.showToast("保存失败。", "error");
        setSaving(false);
      }
    }).catch(function () { setSaving(false); });
  });

  // 删除
  fields.deleteBtn.addEventListener("click", function () {
    if (!fields.id.value || saving) return;
    if (!window.confirm("确定删除这条班次安排吗？")) return;
    setSaving(true);
    fetchJSON("/api/schedules/" + fields.id.value, { method: "DELETE" })
      .then(function (res) {
        if (res.status === 200) {
          window.showToast("班次已删除。", "success");
          setTimeout(function () { window.location.reload(); }, 600);
        } else {
          window.showToast("删除失败。", "error");
          setSaving(false);
        }
      }).catch(function () { setSaving(false); });
  });

  /* ---------- 移动端排班视图：日期选择、固定按钮新增、卡片快捷删除、冲突展开/收起 ---------- */

  // 顶部日期选择：切换后跳转到对应日期的排班页
  var mDate = document.getElementById("m-date");
  if (mDate) {
    mDate.addEventListener("change", function () {
      if (!this.value) return;
      var params = new URLSearchParams(window.location.search);
      params.set("date", this.value);
      window.location.href = "/schedule?" + params.toString();
    });
  }

  // 移动端固定按钮/空态按钮 → 新增班次（日期预填为所选日期）
  window.openShiftDialogForDate = function (dateText) {
    resetDialog();
    if (dateText) fields.date.value = dateText;
    dlg.showModal();
    fields.employee.focus();
  };

  // 移动端卡片删除：一步确认，直接删除
  window.quickDeleteShift = function (id, employeeName) {
    if (saving) return;
    var who = employeeName ? "“" + employeeName + "”的" : "";
    if (!window.confirm("确定删除" + who + "这条班次安排吗？")) return;
    saving = true;
    fetchJSON("/api/schedules/" + id, { method: "DELETE" })
      .then(function (res) {
        if (res.status === 200) {
          window.showToast("班次已删除。", "success");
          setTimeout(function () { window.location.reload(); }, 600);
        } else {
          window.showToast("删除失败。", "error");
          saving = false;
        }
      }).catch(function () { saving = false; });
  };

  // 移动端长冲突文案：展开 / 收起（图标箭头 + 文字共同表达状态）
  // 移动端卡片操作：事件委托（data 属性承载班次数据，避免内联 onclick 转义问题）
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest && ev.target.closest("[data-shift-edit]");
    if (!btn) return;
    ev.stopPropagation();
    var data = jsonParseSafe(btn.getAttribute("data-emp"));
    if (data) openShiftDialogForEdit(data);
  });

  document.addEventListener("click", function (ev) {
    var cell = ev.target.closest && ev.target.closest("[data-cell-employee]");
    if (!cell || ev.target.closest("[data-shift-edit]")) return;
    openShiftDialogForCell(
      cell.getAttribute("data-cell-employee"),
      cell.getAttribute("data-cell-date"),
      cell.getAttribute("data-cell-name"));
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    var cell = ev.target.closest && ev.target.closest("[data-cell-employee]");
    if (!cell || ev.target.closest("[data-shift-edit]")) return;
    ev.preventDefault();
    openShiftDialogForCell(
      cell.getAttribute("data-cell-employee"),
      cell.getAttribute("data-cell-date"),
      cell.getAttribute("data-cell-name"));
  });

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest && ev.target.closest("[data-shift-delete]");
    if (!btn) return;
    quickDeleteShift(btn.getAttribute("data-shift-id"), btn.getAttribute("data-shift-name") || "");
  });

  function jsonParseSafe(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  var copyBtn = document.getElementById("copy-prev-week");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      if (copyBtn.disabled) return;
      copyBtn.disabled = true;
      var targetDate = copyBtn.getAttribute("data-target-date");
      fetchJSON("/api/schedules/copy-week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_date: targetDate })
      }).then(function (preview) {
        if (preview.status !== 200) throw new Error("preview failed");
        var d = preview.data;
        if (!d.copy_count) {
          window.showToast("上周没有可复制的班次；已有安排或停用员工已跳过。", "warning");
          copyBtn.disabled = false;
          return;
        }
        var summary = "将 " + d.source_start + " 至 " + d.source_end + " 的 " + d.copy_count +
          " 个班次复制到本周。\n跳过已有 " + d.skipped_existing + " 个，停用员工 " +
          d.skipped_inactive + " 个。\n预检发现错误 " + d.error_count + " 条、提示 " +
          d.warning_count + " 条。\n\n确定继续吗？";
        if (!window.confirm(summary)) {
          copyBtn.disabled = false;
          return;
        }
        return fetchJSON("/api/schedules/copy-week", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_date: targetDate, confirm: true })
        }).then(function (saved) {
          if (saved.status !== 201) throw new Error("copy failed");
          window.showToast("已复制 " + saved.data.created + " 个班次。", "success");
          setTimeout(function () { window.location.reload(); }, 650);
        });
      }).catch(function () {
        window.showToast("复制失败，请稍后重试。", "error");
        copyBtn.disabled = false;
      });
    });
  }

  // 移动端长冲突文案：展开 / 收起（文字 + aria 状态共同表达）
  document.addEventListener("click", function (ev) {
    var t = ev.target.closest && ev.target.closest("[data-conf-toggle]");
    if (!t) return;
    var row = t.closest(".m-conf");
    var msg = row && row.querySelector(".m-conf-msg");
    if (!msg) return;
    var expanded = t.getAttribute("aria-expanded") === "true";
    t.setAttribute("aria-expanded", expanded ? "false" : "true");
    t.textContent = expanded ? "展开" : "收起";
    msg.classList.toggle("clamp", expanded);
  });
})();
