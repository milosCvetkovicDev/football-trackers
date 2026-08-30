/* Self-hosted mermaid rendering.
 *
 * WHY THIS FILE EXISTS. mkdocs-material ships its own mermaid integration, which fetches
 * mermaid from unpkg at a FLOATING major version (`mermaid@11`) and runs it in every
 * reader's browser. This repo already pins its supply chain (checksum-pinned model weights, SHA-pinned actions)
 * by version and checksum; publishing that rule inside a page that violates it would be a
 * poor advertisement for it.
 *
 * Material's integration keys on the class `mermaid`, and it does NOT stand down when a
 * mermaid instance is already loaded — verified by experiment: it empties the element and
 * renders with its own fetched copy, leaving a blank box when that fetch fails. So the
 * fences are emitted with the class `diagram` (see mkdocs.yml), which Material ignores,
 * and rendered here with the pinned build site/build.py vendors and checksums.
 *
 * Net effect: the published site makes no third-party request to draw its diagrams.
 */
(function () {
  "use strict";

  function currentTheme() {
    var scheme = document.body.getAttribute("data-md-color-scheme");
    return scheme === "slate" ? "dark" : "default";
  }

  function sourceOf(el) {
    // superfences emits <pre class="diagram"><code>…</code></pre>
    var code = el.querySelector("code");
    return (code ? code.textContent : el.textContent) || "";
  }

  var counter = 0;

  async function renderAll() {
    if (typeof window.mermaid === "undefined") return;

    var blocks = document.querySelectorAll("pre.diagram, .diagram");
    if (!blocks.length) return;

    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: currentTheme(),
      // useMaxWidth:false makes mermaid emit an intrinsic pixel width instead of
      // width="100%". With 100%, a 2500px-wide flowchart is squeezed into a ~700px
      // column at ~27% scale — rendered, technically, and unreadable in practice.
      // At natural size the container scrolls horizontally instead, which keeps the
      // labels legible. Wide diagrams are wide; pretending otherwise helps nobody.
      flowchart: { htmlLabels: true, curve: "basis", useMaxWidth: false },
      sequence: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
    });

    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      var src = el.getAttribute("data-diagram-src") || sourceOf(el);
      if (!src.trim()) continue;
      // Keep the source so a theme switch can re-render from it.
      el.setAttribute("data-diagram-src", src);
      try {
        var out = await window.mermaid.render("diagram-" + counter++, src);
        var fig = document.createElement("div");
        fig.className = "diagram-rendered";
        fig.innerHTML = out.svg;
        el.replaceWith(fig);
        fig.setAttribute("data-diagram-src", src);
      } catch (err) {
        // Leave the source visible rather than showing an empty box: a reader who can
        // see the code can still follow it, and the CI mermaid gate means this should
        // never happen in a published build.
        console.error("mermaid render failed", err);
      }
    }
  }

  function boot() {
    renderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Material's instant-navigation swaps content without a page load.
  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(function () {
      renderAll();
    });
  }
})();
