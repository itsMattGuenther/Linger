// The theme chosen on this computer or phone, put on the page before it
// draws (#964, src/next/core/theme.ts). Every window loads next.html, which
// runs this first, as a plain script that holds up the page until it's
// done. The app's own code is a module, which runs only after the page could
// already have drawn The door's colors for a moment. The page's content
// security policy runs only Linger's own files (script-src 'self'), so this
// is a file rather than a script written into the page.
//
// The key and the themes are core/theme.ts's; theme.test.ts checks they
// match. Anything else, or storage that won't answer, is The door.
(function () {
  var THEMES = ["door", "after-dark", "porch-light", "dusk", "original", "daylight"];
  var theme = "door";
  try {
    var saved = window.localStorage.getItem("linger.next.theme");
    if (THEMES.indexOf(saved) >= 0) theme = saved;
  } catch (refused) {
    // Storage switched off: The door.
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
