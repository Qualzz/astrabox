import { mountCabinetPanel } from "./cabinet-panel.js";

// Native imagegen alpha is kept untouched, not computed in the browser. Only the small
// CSS tubes animate; the illustrated housing stays outside the CRT pass.

export function mountCabinet() {
  const existing = document.querySelector(".crt-content");
  if (existing) return existing;
  const content = document.createElement("div");
  content.className = "crt-content";
  const children = [...document.body.children].filter(element => element.tagName !== "SCRIPT");
  content.append(...children);

  const cabinet = document.createElement("div");
  cabinet.className = "crt-cabinet";
  cabinet.innerHTML = `<div class="crt-picture"></div>
  <img class="crt-housing" src="/assets/cabinet/astrabox-anime-native.png" alt="" aria-hidden="true" draggable="false" fetchpriority="high"> `;
  cabinet.querySelector(".crt-picture").append(content);
  document.body.classList.add("llm-cabinet-page");
  document.body.prepend(cabinet);
  mountCabinetPanel(cabinet);
  return content;
}
