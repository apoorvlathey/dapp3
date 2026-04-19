const params = new URLSearchParams(location.search);
const ensName = params.get("name") ?? "";
const reason = params.get("error") ?? "Unknown error";

const nameEl = document.getElementById("name") as HTMLParagraphElement;
const reasonEl = document.getElementById("reason") as HTMLPreElement;
nameEl.textContent = ensName || "(no name)";
reasonEl.textContent = reason;

document.getElementById("retry")?.addEventListener("click", () => {
  if (!ensName) return;
  location.replace(`http://${ensName}/`);
});

document.getElementById("settings")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
