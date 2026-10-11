/* Top-navigation progressive enhancement.
 *
 * Everything the nav NEEDS to be usable (links, active state via aria-current,
 * logout, theme toggle) is server-rendered. This file only adds the parts that
 * genuinely require a browser: opening/closing the popovers and sheet, focus
 * management for keyboard users, the live next-prayer countdown, and the
 * scroll-aware shadow on the sticky header.
 *
 * No dependencies. ~200 lines, four tiny behaviours, each guarded so a missing
 * element is a silent no-op rather than a console error.
 */
(function () {
  "use strict";

  // ---- Scroll-aware header -------------------------------------------------
  // A single rAF-throttled listener sets data-scrolled on the header after
  // 6px of vertical scroll. CSS handles the blur/shadow change (see
  // style.css) — we just flip the flag so it can react.
  var topnav = document.getElementById("topnav");
  if (topnav) {
    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var y = window.scrollY || document.documentElement.scrollTop || 0;
        var next = y > 6 ? "true" : "false";
        if (topnav.getAttribute("data-scrolled") !== next) {
          topnav.setAttribute("data-scrolled", next);
        }
        ticking = false;
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ---- Popovers (More, Profile) -------------------------------------------
  // Toggle button carries data-nav-pop="<id-of-popover>". Escape and outside
  // click close it; focus returns to the trigger so keyboard users don't get
  // stranded. Only one popover can be open at a time.
  var openPop = null;
  var lastFocus = null;

  function closePop() {
    if (!openPop) return;
    var wrap = openPop.closest(".nav-pop-wrap");
    var btn = wrap && wrap.querySelector("[data-nav-pop]");
    if (btn) btn.setAttribute("aria-expanded", "false");
    openPop.hidden = true;
    openPop = null;
    if (lastFocus && document.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (e) {}
    }
    lastFocus = null;
  }

  function openPopById(id, trigger) {
    var el = document.getElementById(id);
    if (!el) return;
    if (openPop === el) { closePop(); return; }
    closePop();
    lastFocus = trigger || document.activeElement;
    el.hidden = false;
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    openPop = el;
    // Focus the first item so Tab lands inside the menu immediately.
    var first = el.querySelector("[role='menuitem']");
    if (first) { try { first.focus(); } catch (e) {} }
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-nav-pop]");
    if (btn) {
      var id = btn.getAttribute("data-nav-pop");
      if (id === "nav-sheet") { openSheet(btn); }
      else { openPopById(id, btn); }
      e.preventDefault();
      return;
    }
    // Anything inside the currently-open popover (links, forms) is allowed to
    // behave normally; the outside-click path just closes it.
    if (openPop && !openPop.contains(e.target)) closePop();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (sheetOpen) closeSheet();
      else closePop();
    }
  });

  // Close popovers when a link inside them is followed (native navigation
  // would clear state anyway, but this avoids a flash on same-tab clicks).
  document.addEventListener("click", function (e) {
    if (openPop && e.target.closest && e.target.closest("a")) closePop();
  });

  // ---- Bottom sheet (mobile) ----------------------------------------------
  var sheetWrap = document.getElementById("nav-sheet-wrap");
  var sheetOpen = false;
  var sheetLastFocus = null;

  function openSheet(trigger) {
    if (!sheetWrap) return;
    closePop();
    sheetWrap.hidden = false;
    // Animate on next frame so the transition actually fires.
    requestAnimationFrame(function () { sheetWrap.setAttribute("data-open", "true"); });
    document.body.classList.add("nav-sheet-lock");
    sheetOpen = true;
    sheetLastFocus = trigger || document.activeElement;
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    var panel = document.getElementById("nav-sheet");
    if (panel) { try { panel.focus(); } catch (e) {} }
  }
  function closeSheet() {
    if (!sheetWrap || !sheetOpen) return;
    sheetWrap.setAttribute("data-open", "false");
    sheetOpen = false;
    document.body.classList.remove("nav-sheet-lock");
    var trig = document.querySelector('[data-nav-pop="nav-sheet"][aria-expanded="true"]');
    if (trig) trig.setAttribute("aria-expanded", "false");
    // Wait for the slide-down transition before we yank it out of the tree.
    setTimeout(function () {
      if (!sheetOpen) {
        sheetWrap.hidden = true;
        if (sheetLastFocus && document.contains(sheetLastFocus)) {
          try { sheetLastFocus.focus(); } catch (e) {}
        }
        sheetLastFocus = null;
      }
    }, 260);
  }
  document.addEventListener("click", function (e) {
    if (!sheetWrap) return;
    if (e.target.closest && e.target.closest("[data-nav-dismiss]")) closeSheet();
    // Followed a link inside the sheet? Close it before navigating so the
    // destination page doesn't inherit a scroll-locked body.
    if (sheetOpen && e.target.closest && e.target.closest("#nav-sheet a")) closeSheet();
  });

  // ---- Search expand ------------------------------------------------------
  var search = document.getElementById("nav-search");
  if (search) {
    var btn = search.querySelector(".nav-search-toggle");
    var field = search.querySelector(".nav-search-field");
    var input = field && field.querySelector("input");
    function setSearch(open) {
      search.setAttribute("data-open", open ? "true" : "false");
      if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (field) field.hidden = !open;
      if (open && input) { try { input.focus(); } catch (e) {} }
    }
    if (btn) btn.addEventListener("click", function (e) {
      e.stopPropagation();
      setSearch(search.getAttribute("data-open") !== "true");
    });
    // The "Search members" item inside the More popover bridges to here.
    document.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("[data-open-search]")) {
        closePop();
        setSearch(true);
      }
    });
    if (input) input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { input.value = ""; input.dispatchEvent(new Event("input")); setSearch(false); }
    });
  }

  // ---- Next-prayer chip ---------------------------------------------------
  // Fetches the same value /times uses (via /api/next-prayer) and ticks the
  // countdown locally. Rounded to whole minutes on purpose — a nav chip
  // shouldn't be a stopwatch. Refetches every 10 min (or on tab-return) so
  // it self-heals across prayer boundaries.
  var chip = document.getElementById("next-prayer");
  var nameEl = document.getElementById("np-name");
  var timeEl = document.getElementById("np-time");
  var target = null;
  var timer = null;

  function fmtRemain(ms) {
    if (ms <= 0) return "now";
    var totalMin = Math.floor(ms / 60000);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h === 0) return "in " + m + "m";
    if (h < 24) return "in " + h + "h " + (m > 0 ? m + "m" : "0m");
    var d = Math.floor(h / 24);
    return "in " + d + "d " + (h % 24) + "h";
  }
  function paint() {
    if (!chip || !target) return;
    var remain = target.getTime() - Date.now();
    timeEl.textContent = fmtRemain(remain);
    if (remain <= 0) {
      // Past the target: refresh so the chip rolls to the following prayer.
      loadChip();
    }
  }
  function loadChip() {
    fetch("/api/next-prayer", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.next) { if (chip) chip.hidden = true; return; }
        target = new Date(data.next.at);
        nameEl.textContent = data.next.name + (data.next.isTomorrow ? " (tom.)" : "");
        chip.hidden = false;
        paint();
      })
      .catch(function () { /* offline or 500: chip stays hidden — no error toast */ });
  }
  if (chip) {
    loadChip();
    // Tick every 30 s to update the display without doing per-second work.
    if (!timer) timer = setInterval(paint, 30000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        // Only refetch if the previous target has already passed — otherwise
        // the browser's local clock keeps the chip accurate for hours.
        if (!target || target.getTime() <= Date.now()) loadChip();
        else paint();
      }
    });
  }
})();
