// A small popover list (market and token pickers): a floating white card anchored under a chip. Closes on selection,
// outside click or Escape; arrow keys move between options.

export interface PickOption {
  value: string;
  label: string;
  sub?: string;
  right?: string;
  icon?: string; // trusted HTML (a coin)
  group?: string;
  disabled?: boolean;
}

let open: { el: HTMLElement; close: () => void } | undefined;

export function closePicker() {
  open?.close();
}

export function openPicker(anchor: HTMLElement, title: string, options: PickOption[], selected: string, onPick: (value: string) => void) {
  if (open?.el.dataset.anchor === anchor.id) return closePicker(); // a second click on the same chip toggles it
  closePicker();
  const el = document.createElement("div");
  el.className = "picker";
  el.dataset.anchor = anchor.id;
  el.setAttribute("role", "listbox");
  el.setAttribute("aria-label", title);
  let html = `<div class="picker-title">${title}</div>`;
  let group: string | undefined;
  for (const o of options) {
    if (o.group && o.group !== group) {
      group = o.group;
      html += `<div class="picker-group">${o.group}</div>`;
    }
    html += `<button type="button" class="picker-opt${o.value === selected ? " on" : ""}" role="option" aria-selected="${o.value === selected}" data-value="${o.value}"${o.disabled ? " disabled" : ""}>
      ${o.icon ?? ""}<span class="picker-text"><span class="picker-label">${o.label}</span>${o.sub ? `<span class="picker-sub">${o.sub}</span>` : ""}</span>
      ${o.right ? `<span class="picker-right">${o.right}</span>` : ""}${o.value === selected ? '<span class="picker-check" aria-hidden="true">✓</span>' : ""}
    </button>`;
  }
  el.innerHTML = html;
  document.body.appendChild(el);

  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
  el.style.left = `${left + window.scrollX}px`;
  el.style.top = `${r.bottom + 8 + window.scrollY}px`;
  anchor.setAttribute("aria-expanded", "true");

  const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>(".picker-opt:not([disabled])"));
  buttons.forEach((b) => (b.onclick = () => (closePicker(), onPick(b.dataset.value!))));
  (buttons.find((b) => b.classList.contains("on")) ?? buttons[0])?.focus();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return closePicker(), anchor.focus();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) closePicker();
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onDown);
  open = {
    el,
    close: () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      anchor.setAttribute("aria-expanded", "false");
      el.remove();
      open = undefined;
    },
  };
}
