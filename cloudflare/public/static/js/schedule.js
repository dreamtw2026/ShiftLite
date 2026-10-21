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
  var pendingPayload = null;
  var forceOnce = false;
  var saving = false;
  var motionOK = !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var TEMPLATES = window.SHIFTLITE_TEMPLATES || [];

  function severityIcon(sev) {
    var path = sev === "error"
      ? '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
      : '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
    return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + "</svg>";
  }

  function showConflicts(conflicts) {
    conflictList.innerHTML = "";
    (conflicts || []).forEach(function (c) {
      var li = document.createElement("li");
      li.className = "sev-" + c.severity;
      li.innerHTML = severityIcon(c.severity) + "<span><b>" +
        (c.rule_label || c.rule) + "：</b>" + c.message + "</span>";
      conflictList.appendChild(li);
    });
    var hasError = (conflicts || []).some(function (c) { return c.severity === "error"; });
    conflictBox.style.display = conflicts && conflicts.length ? "block" : "none";
    fields.forceBtn.style.display = hasError ? "inline-flex" : "none";
    fields.submitBtn.textContent = hasError ? "返回修改" : "保存";
  }

  function resetDialog() {
    form.reset();
    fields.id.value = "";
    fields.deleteBtn.style.display = "none";
    conflictBox.style.display = "none";
    errorBox.style.display = "none";
    fields.forceBtn.style.display = "none";
    fields.submitBtn.textContent = "保存";
  }

  function applyTemplate(tplId) {
    var tpl = TEMPLATES.find(function (t) { return String(t.id) === String(tplId); });
    if (!tpl) return;
    fields.start.value = tpl.start_time;
    fields.end.value = tpl.end_time;
    fields.brk.value = tpl.break_minutes;
    if (tpl.position && !fields.position.value) fields.position.value = tpl.position;
  }

  /* ---------- 冲突定位：滚动到目标班次并短暂高亮 ---------- */
  function locateShift(id) {
    var el = document.getElementById("shift-" + id);
    if (!el) return false;
    el.scrollIntoView({ behavior: motionOK ? "smooth" : "auto", block: "center", inline: "center" });
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
    resetDialog();
    fields.title.textContent = "新增班次";
    fields.employee.value = String(employeeId);
    fields.date.value = dateText;
    document.getElementById("sf-employee-name").textContent = employeeName || "";
    dlg.showModal();
    fields.employee.focus(); // 聚焦第一个必填字段
  };

  // 点击班次芯片 → 编辑
  window.openShiftDialogForEdit = function (data) {
    resetDialog();
    fields.title.textContent = "调整班次";
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
    fields.deleteBtn.style.display = "inline-flex";
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
    fields.submitBtn.textContent = "保存";
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

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest && ev.target.closest("[data-shift-edit]");
    if (!btn) return;
    ev.stopPropagation();
    try { openShiftDialogForEdit(JSON.parse(btn.getAttribute("data-emp"))); } catch (e) {}
  });

  document.addEventListener("click", function (ev) {
    var cell = ev.target.closest && ev.target.closest("[data-cell-employee]");
    if (!cell || ev.target.closest("[data-shift-edit]")) return;
    openShiftDialogForCell(cell.getAttribute("data-cell-employee"),
      cell.getAttribute("data-cell-date"), cell.getAttribute("data-cell-name"));
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    var cell = ev.target.closest && ev.target.closest("[data-cell-employee]");
    if (!cell || ev.target.closest("[data-shift-edit]")) return;
    ev.preventDefault();
    openShiftDialogForCell(cell.getAttribute("data-cell-employee"),
      cell.getAttribute("data-cell-date"), cell.getAttribute("data-cell-name"));
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

  var copyBtn = document.getElementById("copy-prev-week");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      if (copyBtn.disabled) return;
      copyBtn.disabled = true;
      var targetDate = copyBtn.getAttribute("data-target-date");
      fetchJSON("/api/schedules/copy-week", {
        method: "POST", headers: { "Content-Type": "application/json" },
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
        if (!window.confirm(summary)) { copyBtn.disabled = false; return; }
        return fetchJSON("/api/schedules/copy-week", {
          method: "POST", headers: { "Content-Type": "application/json" },
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
})();
