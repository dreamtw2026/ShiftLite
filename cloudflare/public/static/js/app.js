/* 轻排班 · 公共前端交互（原生 JS，无第三方依赖） */
(function () {
  "use strict";

  // 全局动效偏好：系统开启“减少动态效果”时，滚动与动效降级
  window.motionOK = !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  var SNACK_ICONS = {
    success: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  var snackTimer = null;
  window.showToast = function (message, type) {
    type = type || "info";
    var bar = $("#snackbar");
    if (!bar) return;
    bar.className = "snackbar show " + type;
    bar.innerHTML = (SNACK_ICONS[type] || SNACK_ICONS.info) + "<span></span>";
    bar.lastElementChild.textContent = message;
    clearTimeout(snackTimer);
    snackTimer = setTimeout(function () { bar.className = "snackbar"; }, 3600);
  };

  window.openDialog = function (id) {
    var dlg = document.getElementById(id);
    if (dlg && typeof dlg.showModal === "function") dlg.showModal();
    return dlg;
  };
  window.closeDialog = function (id) {
    var dlg = document.getElementById(id);
    if (dlg) dlg.close();
  };

  function fetchJSON(url, options) {
    return fetch(url, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }
  window.fetchJSON = fetchJSON;

  document.addEventListener("DOMContentLoaded", function () {
    // 服务器闪现消息 → 提示条
    var flashNode = $("#flash-data");
    if (flashNode) {
      try {
        JSON.parse(flashNode.textContent).forEach(function (m) {
          window.showToast(m.message, m.category || "info");
        });
      } catch (e) { /* 忽略解析异常 */ }
    }

    // 对话框开关
    $all("[data-dialog-open]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var dlg = window.openDialog(btn.getAttribute("data-dialog-open"));
        if (dlg && typeof btn.getAttribute("data-dialog-fill") === "string") {
          var fillFn = window[btn.getAttribute("data-dialog-fill")];
          if (typeof fillFn === "function") fillFn(btn);
        }
        if (dlg) {
          var first = dlg.querySelector(".dialog-body input[required], .dialog-body select[required]");
          if (first) { try { first.focus(); } catch (e) { /* 忽略聚焦异常 */ } }
        }
      });
    });

    // 横向滚动提示：用户滚动过一次后隐藏
    $all("[data-scroll-hint]").forEach(function (hint) {
      var target = document.querySelector(hint.getAttribute("data-scroll-hint"));
      if (target) target.addEventListener("scroll", function () {
        hint.classList.add("hide");
      }, { once: true, passive: true });
    });
    $all("[data-dialog-close]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var dlg = btn.closest("dialog");
        if (dlg) dlg.close();
      });
    });

    // 危险操作确认
    $all("form[data-confirm]").forEach(function (form) {
      form.addEventListener("submit", function (ev) {
        if (!window.confirm(form.getAttribute("data-confirm"))) ev.preventDefault();
      });
    });
  });
})();
