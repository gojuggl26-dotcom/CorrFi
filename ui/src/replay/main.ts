// Replay page: subscribes to the Driver (frames, ws :8787) and the Verifier (results, ws :8789), keeps the last
// state when a connection drops and reconnects (R §8.3). START is a POST to the Driver.
import { initialState, type ReplayState, reduceDriver, reduceVerifier } from "./state.ts";
import { render } from "./view.ts";

const q = new URLSearchParams(location.search);
const DRIVER = q.get("driver") ?? "127.0.0.1:8787";
const VERIFIER = q.get("verifier") ?? "127.0.0.1:8789";

let state: ReplayState = initialState();
let dirty = true;

function subscribe(host: string, reduce: (s: ReplayState, m: Record<string, unknown>) => ReplayState, onOpen: () => void) {
  const open = () => {
    const ws = new WebSocket(`ws://${host}`);
    ws.onopen = onOpen;
    ws.onmessage = (ev) => {
      state = reduce(state, JSON.parse(ev.data));
      dirty = true;
    };
    ws.onclose = () => setTimeout(open, 500); // keep the last state and retry
  };
  open();
}

// the Driver replays its history to a new connection: start from a clean state each time
subscribe(DRIVER, reduceDriver, () => {
  const verify = state.verify;
  state = { ...initialState(), verify };
});
subscribe(VERIFIER, reduceVerifier, () => {
  state = { ...state, verify: { items: {}, done: false } };
});

// the plan's label until every testnet maturity is confirmed; ?stage=<text> replaces it (e.g. after S08 completes)
const stage = q.get("stage");
if (stage !== null) document.getElementById("stageNote")!.textContent = stage;

document.getElementById("start")!.addEventListener("click", () => {
  fetch(`http://${DRIVER}/start`, { method: "POST" }).catch(() => {});
});

const loop = () => {
  if (dirty) {
    render(state);
    dirty = false;
  }
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
