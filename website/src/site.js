// Wires the two demo frames together and shows what a click would run.
const frames = [...document.querySelectorAll(".desk iframe")];
const term = document.getElementById("term");
const termTitle = document.getElementById("term-title");

function esc(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

window.addEventListener("message", (e) => {
  const msg = e.data || {};
  if (msg.type === "settings-changed") {
    for (const f of frames) if (f.contentWindow !== e.source) f.contentWindow.postMessage(msg, "*");
  } else if (msg.type === "open") {
    termTitle.textContent = msg.title;
    term.innerHTML =
      `<span class="p">$</span> cd ${esc(msg.cwd)} &amp;&amp; claude --resume ${esc(msg.id)}\n\n` +
      `<span class="ok">✻</span> Resuming “${esc(msg.title)}”\n` +
      `<span class="dim">  The full conversation is loaded back, in ${esc(msg.cwd)}.\n` +
      `  (On your Mac this opens as a new Terminal window.)</span>`;
  } else if (msg.type === "open-settings") {
    const win = document.getElementById("settings-win");
    win.scrollIntoView({ behavior: "smooth", block: "center" });
    win.classList.add("flash");
    setTimeout(() => win.classList.remove("flash"), 900);
  }
});

for (const btn of document.querySelectorAll(".copy")) {
  btn.addEventListener("click", async () => {
    const text = btn.parentElement.querySelector("pre").innerText.replace(/\s+#.*$/gm, "");
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Select & copy";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
}
