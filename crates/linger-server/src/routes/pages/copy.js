// The Copy button on a shared link's page (PROTOCOL §2.2), and the only script
// the page runs: it is hashed into the page's Content-Security-Policy. Without
// it the button stays hidden and the link can still be selected by hand.
(function () {
  var button = document.getElementById("copy");
  var link = document.getElementById("link");
  if (!button || !link) return;
  button.hidden = false;
  var reset;
  function done(said) {
    button.textContent = said;
    clearTimeout(reset);
    reset = setTimeout(function () { button.textContent = "Copy"; }, 2000);
  }
  function selectLink() {
    var range = document.createRange();
    range.selectNodeContents(link);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function fallback() {
    selectLink();
    var copied = false;
    try { copied = document.execCommand("copy"); } catch (e) { copied = false; }
    done(copied ? "Copied" : "Selected");
  }
  button.addEventListener("click", function () {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link.textContent).then(function () { done("Copied"); }, fallback);
    } else {
      fallback();
    }
  });
})();
