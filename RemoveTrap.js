// ========== Circuit Trap Solver (Hints-as-Suggestions, In-Memory, Clear Logs) – Patched ==========
// Fixes:
// 1) Guard against undefined hint step (path exhausted): skip such hints safely.
// 2) Extra safety in press(): reject non-number btnIds to avoid gumpReply error.
// 3) Keep original behavior, delays, and logs.
// Uses brute force, tries to learn as it goes, is right 30% - 40% of the time
// rather low but best I can do


const CT_KIT_SERIAL   = 0x40017C5B; // south most trap box id in community center, change this if you use a different box
const CLICK_DELAY_MS  = 0;
const RESULT_WAIT_MS  = 600;    // journal settle time
const FAIL_WAIT_MS    = 3500;   // after reset message
const SUCCESS_WAIT_MS = 8500;   // after success message
const OPEN_PAUSE_MS   = 100;
const COOLDOWN_MS     = 250;    // tiny idle between cycles

const BTN  = { U:1, R:2, D:3, L:4 };
const NAME = { 1:"up", 2:"right", 3:"down", 4:"left" };
const ORDER = [BTN.R, BTN.D, BTN.L, BTN.U];

const MSG_SUCCESS = "You successfully disarm the trap!";
const MSG_FAIL    = "You fail to disarm the trap and reset it.";

let confirmed = [];          // working sequence so far (kept across resets; cleared only if replay fails)
let branchHistory = {};      // { "x,y": [moves tried here] } persists for current puzzle
let solvedPaths = [];        // [{ size, path:[...], count }]
let failedHintPaths = new Set(); // set of path strings that failed *this session only*

let totalSolved = 0, totalFailed = 0;

// --- helpers (ClassicUO API) ---
function jclear(){ journal.clear(); }
function jhas(t){ return journal.containsText(t); }

function openTrap(){
  player.useSkill(Skills.RemoveTrap);
  target.waitTargetEntity(CT_KIT_SERIAL);
  const g = Gump.findOrWait("Trap Disarm Mechanism", 5000);
  if (!g || !g.exists){ console.log("⚠️ Gump not found."); return null; }
  console.log(`✅ Gump opened (serial=${g.serial})`);
  sleep(OPEN_PAUSE_MS);
  return g;
}

function press(g, btnId){
  if (!g || !g.exists) return {state:"closed", g:null};
  if (typeof btnId !== "number" || !(btnId in NAME)) {
    console.log("⚠️ Skipping invalid button id:", btnId);
    return {state:"ok", g}; // no-op to keep loop stable
  }
  jclear();
  g.reply(btnId);
  console.log(`➡️ ${NAME[btnId]}`);
  sleep(CLICK_DELAY_MS + RESULT_WAIT_MS);
  const ng = Gump.findOrWait("Trap Disarm Mechanism", 1000);
  if (jhas(MSG_SUCCESS)) return {state:"solved", g:ng};
  if (jhas(MSG_FAIL))    return {state:"fail",   g:ng};
  if (!ng || !ng.exists) return {state:"closed", g:null};
  return {state:"ok", g:ng};
}

function dimFromSkill(){
  const s = player.getSkill(Skills.RemoveTrap).value / 10.0;
  return (s >= 100) ? 5 : (s >= 80 ? 4 : 3);
}

// avoid revisits & bounds under assumed dim
function legalMoves(dim, x, y, visited){
  const out = [];
  if (x+1 < dim && !visited.has(`${x+1},${y}`)) out.push(BTN.R);
  if (y+1 < dim && !visited.has(`${x},${y+1}`)) out.push(BTN.D);
  if (x-1 >= 0 && !visited.has(`${x-1},${y}`)) out.push(BTN.L);
  if (y-1 >= 0 && !visited.has(`${x},${y-1}`)) out.push(BTN.U);
  return out;
}

const DX = { 1:0, 2:1, 3:0, 4:-1 };
const DY = { 1:-1, 2:0, 3:1, 4:0 };

// Find known paths that start with current confirmed prefix and are not marked failed this session
function matchingHintPaths(dim, prefix){
  const prefStr = prefix.join(",");
  const candidates = solvedPaths
    .filter(p => p.size === dim && p.path.length > prefix.length) // strictly longer than prefix
    .filter(p => p.path.slice(0, prefix.length).join(",") === prefStr)
    .filter(p => !failedHintPaths.has(p.path.join(",")))
    .sort((a,b)=> b.count - a.count); // most common first
  if (candidates.length > 0){
    console.log(`📈 Matched ${candidates.length} known path(s) starting with [${prefix.map(m=>NAME[m]).join(", ")}]`);
  }
  return candidates;
}

while (true){
  let g = openTrap();
  if (!g){ sleep(3000); continue; }

  let dim = dimFromSkill();
  console.log(`🧩 Start (assumed ${dim}×${dim}), confirmed=[${confirmed.map(m=>NAME[m]).join(", ")}]`);

  // state for this run
  let x=0, y=0;
  let visited = new Set(["0,0"]);

  // ---------- Replay confirmed moves (verify puzzle hasn't changed) ----------
  if (confirmed.length){
    console.log(`🔁 Replaying: ${confirmed.map(m=>NAME[m]).join(", ")}`);
    let replayOK = true;
    for (const m of confirmed){
      const r = press(g, m);
      if (r.state === "fail" || r.state === "closed"){
        console.log("⚠️ Confirmed move failed → puzzle changed. Clearing memory.");
        confirmed = [];
        branchHistory = {};
        failedHintPaths.clear();
        replayOK = false;
        break;
      }
      if (r.state === "solved"){
        // (rare) solved during replay
        totalSolved++;
        console.log(`🎉 Solved during replay!`);
        console.log(`📊 Solved=${totalSolved} Failed=${totalFailed} (${Math.round(100*totalSolved/(totalSolved+totalFailed))}% success)`);
        confirmed = [];
        branchHistory = {};
        failedHintPaths.clear();
        sleep(SUCCESS_WAIT_MS);
        replayOK = false;
        break;
      }
      x += DX[m]; y += DY[m];
      visited.add(`${x},${y}`);
      g = r.g;
      while ((x >= dim || y >= dim) && dim < 5){
        dim++;
        console.log(`🧠 Auto-upgraded to ${dim}×${dim} (progress exceeded bounds)`);
      }
    }
    if (!replayOK){ sleep(COOLDOWN_MS); continue; }
  }

  // ---------- Explore with hints-as-suggestions ----------
  let exploring = true;
  while (exploring){
    const key = `${x},${y}`;
    if (!branchHistory[key]) branchHistory[key] = [];

    // 1) Try a hint if any known path matches current prefix
    const hints = matchingHintPaths(dim, confirmed);
    let hintedTried = false;
    for (const hint of hints){
      // guard: ensure the known path actually has a next step beyond current prefix
      if (!hint.path || hint.path.length <= confirmed.length) continue;

      const nextMove = hint.path[confirmed.length]; // next step in that known path
      if (typeof nextMove !== "number" || !(nextMove in NAME)) continue; // safety
      // skip if already tried from this coord
      if (branchHistory[key].includes(nextMove)) continue;

      console.log(`💡 Hint: trying next from known path (${hint.count}×): ${NAME[nextMove]}`);
      branchHistory[key].push(nextMove);
      hintedTried = true;

      const r = press(g, nextMove);

      if (r.state === "solved"){
        confirmed.push(nextMove);
        const solvedStr = confirmed.join(",");
        // record (unique with counts)
        const existing = solvedPaths.find(p => p.size === dim && p.path.join(",") === solvedStr);
        if (existing){ existing.count++; }
        else { solvedPaths.push({ size: dim, path: confirmed.slice(), count: 1 }); }
        totalSolved++;
        console.log(`🎉 Solved via hint! Path=[${confirmed.map(m=>NAME[m]).join(", ")}]`);
        console.log(`📊 Solved=${totalSolved} Failed=${totalFailed} (${Math.round(100*totalSolved/(totalSolved+totalFailed))}% success)`);
        confirmed = [];
        branchHistory = {};
        failedHintPaths.clear();
        sleep(SUCCESS_WAIT_MS);
        exploring = false;
        break;
      }

      if (r.state === "fail" || r.state === "closed"){
        // Mark this full path as failed this session; don't try it again
        failedHintPaths.add(hint.path.join(","));
        totalFailed++;
        console.log(`🚫 Hint failed on ${NAME[nextMove]} — marking path unusable this session.`);
        sleep(FAIL_WAIT_MS);
        exploring = false;
        break;
      }

      if (r.state === "ok"){
        confirmed.push(nextMove);
        x += DX[nextMove]; y += DY[nextMove];
        visited.add(`${x},${y}`);
        console.log(`✔️ Hint step accepted → path=[${confirmed.map(m=>NAME[m]).join(", ")}]`);
        g = r.g;
        while ((x >= dim || y >= dim) && dim < 5){
          dim++;
          console.log(`🧠 Auto-upgraded to ${dim}×${dim}`);
        }
        // continue outer loop to look for new hints or explore further
      }
    }
    if (!exploring) break; // solved or failed via hint

    // 2) If no hint was tried (or all hints consumed), do normal exploration with R→D→L→U
    if (!hintedTried){
      // compute legal, remove branches tried at this coordinate
      let moves = legalMoves(dim, x, y, visited)
                    .filter(m => !branchHistory[key].includes(m));

      // upgrade grid if stuck
      while (moves.length === 0 && dim < 5){
        dim++;
        console.log(`🧠 Upgraded grid → ${dim}×${dim} (no legal moves)`);
        moves = legalMoves(dim, x, y, visited)
                  .filter(m => !branchHistory[key].includes(m));
      }

      if (moves.length === 0){
        console.log(`🧱 Stuck at ${key}; wait for reset.`);
        sleep(FAIL_WAIT_MS);
        exploring = false;
        break;
      }

      const next = ORDER.find(m => moves.includes(m));
      branchHistory[key].push(next);
      console.log(`🧭 Exploring: ${[...confirmed, next].map(m=>NAME[m]).join(", ")}`);

      const r = press(g, next);

      if (r.state === "solved"){
        confirmed.push(next);
        const solvedStr = confirmed.join(",");
        const existing = solvedPaths.find(p => p.size === dim && p.path.join(",") === solvedStr);
        if (existing){ existing.count++; }
        else { solvedPaths.push({ size: dim, path: confirmed.slice(), count: 1 }); }
        totalSolved++;
        console.log(`🎉 Solved! Path=[${confirmed.map(m=>NAME[m]).join(", ")}]`);
        console.log(`📊 Solved=${totalSolved} Failed=${totalFailed} (${Math.round(100*totalSolved/(totalSolved+totalFailed))}% success)`);
        confirmed = [];
        branchHistory = {};
        failedHintPaths.clear();
        sleep(SUCCESS_WAIT_MS);
        exploring = false;
        break;
      }

      if (r.state === "fail" || r.state === "closed"){
        totalFailed++;
        console.log(`❌ Failed on ${NAME[next]} from ${key}.`);
        sleep(FAIL_WAIT_MS);
        exploring = false;
        break;
      }

      if (r.state === "ok"){
        confirmed.push(next);
        x += DX[next]; y += DY[next];
        visited.add(`${x},${y}`);
        console.log(`✔️ ${NAME[next]} worked → path=[${confirmed.map(m=>NAME[m]).join(", ")}]`);
        g = r.g;
        while ((x >= dim || y >= dim) && dim < 5){
          dim++;
          console.log(`🧠 Auto-upgraded to ${dim}×${dim}`);
        }
      }
    }
  }

  console.log("⏳ Cooling down...");
  sleep(COOLDOWN_MS);
}
