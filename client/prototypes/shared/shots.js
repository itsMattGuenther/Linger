// `?shots` marks the page for screenshots, which hides prototype-only controls.
if (new URLSearchParams(location.search).has("shots")) document.documentElement.classList.add("shots");
