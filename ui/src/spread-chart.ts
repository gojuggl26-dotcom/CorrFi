// Home page illustration: how the maker's bid and ask follow the fair value. A base spread (solid wash) earns the
// maker's margin; a risk surcharge (hatched) widens it as risk rises. Illustrative prices (inventory neutral), not
// market data. Inline SVG with a crosshair + tooltip (pointer and arrow keys) and a table view.

const FAIR = [0.64, 0.642, 0.638, 0.646, 0.649, 0.645, 0.651, 0.654, 0.65, 0.653, 0.655, 0.654, 0.657];
const ASK = [0.645, 0.647, 0.643, 0.651, 0.654, 0.65, 0.657, 0.6615, 0.6595, 0.665, 0.67, 0.673, 0.68];
const BID = [0.635, 0.637, 0.633, 0.641, 0.644, 0.64, 0.645, 0.6465, 0.6405, 0.641, 0.64, 0.6355, 0.634];
const BASE = 0.005; // half of the base spread

const W = 1000;
const H = 480;
const X0 = 64;
const X1 = 820;
const Y0 = 64;
const Y1 = 420;
const LO = 0.628;
const HI = 0.684;
const TICKS = [0.63, 0.64, 0.65, 0.66, 0.67, 0.68];

const x = (i: number) => X0 + ((X1 - X0) * i) / (FAIR.length - 1);
const y = (v: number) => Y1 - ((v - LO) / (HI - LO)) * (Y1 - Y0);
const f3 = (v: number) => v.toFixed(3);
const f4 = (v: number) => v.toFixed(4);
const line = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
const band = (top: number[], bottom: number[]) =>
  `${line(top)} ${bottom
    .map((v, i) => [i, v] as const)
    .reverse()
    .map(([i, v]) => `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ")} Z`;

export function renderSpreadChart(root: HTMLElement) {
  const up = FAIR.map((v) => v + BASE);
  const dn = FAIR.map((v) => v - BASE);
  const last = FAIR.length - 1;
  const grid = TICKS.map(
    (t) => `<line class="sc-grid" x1="${X0}" x2="${X1}" y1="${y(t)}" y2="${y(t)}" /><text class="sc-tick" x="${X0 - 12}" y="${y(t) + 4}" text-anchor="end">${t.toFixed(2)}</text>`,
  ).join("");

  root.innerHTML = `
    <div class="sc-legend" aria-hidden="true">
      <span><i class="key key-base"></i>Base spread — the maker's margin</span>
      <span><i class="key key-risk"></i>Risk surcharge</span>
      <span><i class="key key-line"></i>Maker's ask / bid</span>
      <span><i class="key key-fair"></i>Fair value</span>
    </div>
    <div class="sc-plot">
      <svg viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="Illustration: the maker's ask and bid around the fair value. While risk is normal they sit one base spread apart; as risk rises a surcharge widens them, to an ask of 0.680 and a bid of 0.634 at the end. Use the left and right arrow keys to read each point.">
        <defs>
          <pattern id="sc-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="7" height="7" class="sc-hatch-bg" /><line x1="0" y1="0" x2="0" y2="7" class="sc-hatch-line" />
          </pattern>
        </defs>
        <text class="sc-axis-title" x="${X0}" y="18">Price (tUSDC per token)</text>
        ${grid}
        <text class="sc-phase" x="${X0}" y="${Y0 - 14}">Normal</text>
        <text class="sc-phase" x="${X1}" y="${Y0 - 14}" text-anchor="end">Risk rising</text>
        <path class="sc-risk" d="${band(ASK, BID)}" />
        <path class="sc-base" d="${band(up, dn)}" />
        <path class="sc-fair" d="${line(FAIR)}" />
        <path class="sc-edge" d="${line(ASK)}" />
        <path class="sc-edge" d="${line(BID)}" />
        <circle class="sc-end sc-end-edge" cx="${x(last)}" cy="${y(ASK[last])}" r="4.5" />
        <circle class="sc-end sc-end-edge" cx="${x(last)}" cy="${y(BID[last])}" r="4.5" />
        <circle class="sc-end sc-end-fair" cx="${x(last)}" cy="${y(FAIR[last])}" r="4" />
        <text class="sc-label" x="${X1 + 16}" y="${y(ASK[last]) - 4}">Maker's ask</text>
        <text class="sc-value" x="${X1 + 16}" y="${y(ASK[last]) + 16}">${f3(ASK[last])}</text>
        <text class="sc-label" x="${X1 + 16}" y="${y(FAIR[last]) - 4}">Fair value</text>
        <text class="sc-value" x="${X1 + 16}" y="${y(FAIR[last]) + 16}">${f3(FAIR[last])}</text>
        <text class="sc-label" x="${X1 + 16}" y="${y(BID[last]) - 4}">Maker's bid</text>
        <text class="sc-value" x="${X1 + 16}" y="${y(BID[last]) + 16}">${f3(BID[last])}</text>
        <line class="sc-time" x1="${X0}" x2="${X1}" y1="${Y1 + 30}" y2="${Y1 + 30}" />
        <path class="sc-time" d="M${X1 - 7} ${Y1 + 25} L${X1} ${Y1 + 30} L${X1 - 7} ${Y1 + 35}" />
        <text class="sc-tick" x="${(X0 + X1) / 2}" y="${Y1 + 50}" text-anchor="middle">Time →</text>
        <g class="sc-cross" visibility="hidden">
          <line class="sc-cross-line" y1="${Y0}" y2="${Y1}" />
          <circle class="sc-cross-dot sc-end-edge" r="4.5" data-s="ask" />
          <circle class="sc-cross-dot sc-end-fair" r="4" data-s="fair" />
          <circle class="sc-cross-dot sc-end-edge" r="4.5" data-s="bid" />
        </g>
        <rect class="sc-hit" x="${X0 - 20}" y="${Y0}" width="${X1 - X0 + 40}" height="${Y1 - Y0}" />
      </svg>
      <div class="sc-tip" role="status" hidden></div>
    </div>
    <details class="sc-table">
      <summary>View as table</summary>
      <table>
        <thead><tr><th>Point</th><th>Maker's bid</th><th>Fair value</th><th>Maker's ask</th><th>Spread</th><th>of which risk</th></tr></thead>
        <tbody>${FAIR.map((f, i) => `<tr><td>${i + 1}</td><td>${f4(BID[i])}</td><td>${f4(f)}</td><td>${f4(ASK[i])}</td><td>${f4(ASK[i] - BID[i])}</td><td>${f4(Math.max(0, ASK[i] - BID[i] - 2 * BASE))}</td></tr>`).join("")}</tbody>
      </table>
    </details>`;

  const svg = root.querySelector("svg")!;
  const cross = svg.querySelector<SVGGElement>(".sc-cross")!;
  const tip = root.querySelector<HTMLElement>(".sc-tip")!;
  const dots = Object.fromEntries(Array.from(svg.querySelectorAll<SVGCircleElement>(".sc-cross-dot")).map((d) => [d.dataset.s!, d]));
  let at = -1;

  const show = (i: number) => {
    at = Math.max(0, Math.min(last, i));
    const cx = x(at);
    cross.setAttribute("visibility", "visible");
    const l = cross.querySelector("line")!;
    l.setAttribute("x1", String(cx));
    l.setAttribute("x2", String(cx));
    for (const [s, vs] of [["ask", ASK], ["fair", FAIR], ["bid", BID]] as const) {
      dots[s].setAttribute("cx", String(cx));
      dots[s].setAttribute("cy", String(y(vs[at])));
    }
    const spread = ASK[at] - BID[at];
    const risk = Math.max(0, spread - 2 * BASE);
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "sc-tip-head";
    head.textContent = `Point ${at + 1} of ${FAIR.length} · ${risk > 0 ? "risk rising" : "normal"}`;
    tip.appendChild(head);
    for (const [cls, label, v] of [["line", "Maker's ask", ASK[at]], ["fair", "Fair value", FAIR[at]], ["line", "Maker's bid", BID[at]]] as const) {
      const r = document.createElement("div");
      r.className = "sc-tip-row";
      const key = document.createElement("i");
      key.className = `key key-${cls}`;
      const b = document.createElement("b");
      b.textContent = f4(v);
      const t = document.createElement("span");
      t.textContent = label;
      r.append(key, b, t);
      tip.appendChild(r);
    }
    const foot = document.createElement("div");
    foot.className = "sc-tip-foot";
    foot.textContent = `Spread ${f4(spread)}${risk > 0 ? ` (risk surcharge ${f4(risk)})` : ""}`;
    tip.appendChild(foot);
    tip.hidden = false;
    // place the tooltip beside the crosshair, inside the plot
    const box = svg.getBoundingClientRect();
    const px = (cx / W) * box.width;
    const left = px + 16 + tip.offsetWidth > box.width ? px - 16 - tip.offsetWidth : px + 16;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${(y(ASK[at]) / H) * box.height}px`;
  };
  const hide = () => {
    cross.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  const indexAt = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    const vx = ((clientX - box.left) / box.width) * W;
    return Math.round(((vx - X0) / (X1 - X0)) * last);
  };
  svg.querySelector(".sc-hit")!.addEventListener("pointermove", (e) => show(indexAt((e as PointerEvent).clientX)));
  svg.querySelector(".sc-hit")!.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(at < 0 ? last : at));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      show((at < 0 ? last : at) + (e.key === "ArrowRight" ? 1 : -1));
    } else if (e.key === "Escape") hide();
  });
}
