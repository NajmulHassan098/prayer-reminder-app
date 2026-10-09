/* Day/night theme controller.
   Loaded synchronously in <head> so the saved theme is applied before the
   page paints (no flash). Dark is the default; light sets data-theme="light". */
(function () {
  var root = document.documentElement;

  function apply(theme) {
    if (theme === 'light') {
      root.setAttribute('data-theme', 'light');
    } else {
      root.removeAttribute('data-theme');
    }
  }

  function current() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  // Apply saved preference immediately (before body renders).
  try {
    apply(localStorage.getItem('theme'));
  } catch (e) {
    /* localStorage unavailable (private mode) — stay on default dark */
  }

  // Public: flip the theme and persist the choice.
  window.toggleTheme = function () {
    var next = current() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('theme', next); } catch (e) {}
    apply(next);
    return next;
  };

  window.getTheme = current;
})();
