/////////////////////////////////////////////////////////////////
//  Circuit Trap Solver – Per-Puzzle Memory + Shortest Path   //
// ----------------------------------------------------------- //
//  • Uses real server paths for 3x3 / 4x4 / 5x5              //
//  • Keeps candidate paths across FAILS for same puzzle      //
//  • Does NOT rebuild candidates after every fail            //
//  • On OK at step i:  keep ONLY paths with that move at i   //
//  • On FAIL/CLOSED at step i: remove ALL with that move     //
//  • Shortest-path-first, biased by expected dim from skill  //
//  • Uses Gump.findOrWait exclusively                        //
/////////////////////////////////////////////////////////////////

const CT_KIT_SERIAL   = 0x40017C5B;
const CLICK_DELAY_MS  = 0;
const RESULT_WAIT_MS  = 600;
const FAIL_WAIT_MS    = 3500;
const SUCCESS_WAIT_MS = 8500;
const OPEN_PAUSE_MS   = 100;
const COOLDOWN_MS     = 150;

const BTN  = { U:1, R:2, D:3, L:4 };
const NAME = { 1:"up", 2:"right", 3:"down", 4:"left" };

const MSG_SUCCESS = "You successfully disarm the trap!";
const MSG_FAIL    = "You fail to disarm the trap and reset it.";

let totalSolved = 0;
let totalFailed = 0;

// ---------------- Journal / Gump helpers ----------------

function jclear(){ journal.clear(); }
function jhas(t){ return journal.containsText(t); }

function openTrap(){
    player.useSkill(Skills.RemoveTrap);
    target.waitTargetEntity(CT_KIT_SERIAL);
    const g = Gump.findOrWait("Trap Disarm Mechanism", 5000);
    if (!g || !g.exists){
        console.log("⚠️ Trap gump not found.");
        return null;
    }
    sleep(OPEN_PAUSE_MS);
    return g;
}

function press(g, btnId){
    if (!g || !g.exists)
        return {state:"closed", g:null};

    jclear();
    g.reply(btnId);
    console.log("➡️ " + NAME[btnId]);
    sleep(CLICK_DELAY_MS + RESULT_WAIT_MS);

    const ng = Gump.findOrWait("Trap Disarm Mechanism", 1000);

    if (jhas(MSG_SUCCESS)) return {state:"solved", g:ng};
    if (jhas(MSG_FAIL))    return {state:"fail",   g:ng};
    if (!ng || !ng.exists) return {state:"closed", g:null};
    return {state:"ok", g:ng};
}

// ---------------- Server Paths (tile indices) ----------------

const Paths9 = [
 [0,1,2,5,8],
 [0,1,4,5,8],
 [0,1,4,3,6,7,8],
 [0,1,4,7,8],
 [0,3,6,7,8],
 [0,3,4,5,8],
 [0,3,4,7,8],
 [0,3,6,7,4,5,8],
 [0,3,6,7,4,1,2,5,8]
];

const Paths16 = [
 [0,1,2,3,7,11,15],
 [0,1,2,6,7,11,15],
 [0,1,2,3,7,6,5,4,8,9,10,11,15],
 [0,1,5,6,7,11,15],
 [0,1,5,4,8,12,13,14,15],
 [0,1,5,4,8,9,10,14,15],
 [0,4,8,12,13,14,15],
 [0,4,8,9,10,6,2,3,7,11,15],
 [0,4,8,9,5,6,7,11,15],
 [0,4,5,6,2,3,7,11,15],
 [0,4,5,6,7,11,10,9,8,12,13,14,15],
 [0,4,5,9,10,11,15]
];

const Paths25 = [
 [0,1,2,3,4,9,14,19,24],
 [0,1,2,7,8,9,14,13,12,11,10,15,20,21,22,23,24],
 [0,1,2,3,4,9,14,13,12,17,22,23,24],
 [0,1,6,7,8,13,12,17,18,19,24],
 [0,1,6,5,10,11,12,17,18,19,24],
 [0,1,6,5,10,15,16,17,12,7,8,9,14,19,24],
 [0,5,6,7,2,3,4,9,14,19,24],
 [0,5,6,11,12,13,18,19,24],
 [0,5,6,11,16,21,22,17,12,7,8,9,14,19,24],
 [0,5,10,15,20,21,22,23,24],
 [0,5,10,11,12,13,8,7,6,1,2,3,4,9,14,19,24],
 [0,5,10,11,16,17,18,23,24]
];

// -------- Convert tile indices → button sequences --------

function convertTilePath(path){
    const finalIndex = path[path.length - 1];
    const dim = Math.sqrt(finalIndex + 1); // 3,4,5

    let moves = [];

    for (let i = 0; i < path.length - 1; i++){
        let a = path[i], b = path[i+1];

        if (b === a - dim)      moves.push(BTN.U);
        else if (b === a + 1)   moves.push(BTN.R);
        else if (b === a + dim) moves.push(BTN.D);
        else if (b === a - 1)   moves.push(BTN.L);
        else {
            console.log("⚠️ Non-adjacent step in path: " + a + " → " + b);
            return null;
        }
    }

    return { dim: dim, moves: moves };
}

// -------- Build path sets per dimension --------

let allPathsByDim = {3:[],4:[],5:[]};

(function initPaths(){
    for (let p of Paths9){  const c = convertTilePath(p); if (c) allPathsByDim[3].push(c); }
    for (let p of Paths16){ const c = convertTilePath(p); if (c) allPathsByDim[4].push(c); }
    for (let p of Paths25){ const c = convertTilePath(p); if (c) allPathsByDim[5].push(c); }
    console.log(
        "🔧 Loaded paths - 3x3:", allPathsByDim[3].length,
        "4x4:", allPathsByDim[4].length,
        "5x5:", allPathsByDim[5].length
    );
})();

// -------- Expected / allowed dimensions from skill --------

function expectedDimFromSkill(){
    const s = player.getSkill(Skills.RemoveTrap).value / 10.0;
    if (s < 80.0)  return 3;
    if (s < 100.0) return 4;
    return 5;
}

function allowedDimsFromSkill(){
    const s = player.getSkill(Skills.RemoveTrap).value / 10.0;
    if (s < 100.0) return [3, 4];
    return [3, 4, 5];
}

// -------- Per-puzzle candidate memory --------
// For the current puzzle ONLY, across multiple fails.

let candidates = [];
let puzzleInitialized = false;

// Build candidates for current puzzle (once per puzzle)
function buildCandidatesForCurrentSkill(){
    const dims = allowedDimsFromSkill();
    candidates = [];
    for (let d of dims){
        const list = allPathsByDim[d];
        for (let p of list){
            candidates.push({ dim: d, moves: p.moves.slice() });
        }
    }
    puzzleInitialized = true;
    console.log(
        "🔄 New puzzle candidates for dims [" + dims.join(",") + "], total=" + candidates.length
    );
}

// Reset puzzle memory after: success or contradiction
function resetPuzzleMemory(){
    candidates = [];
    puzzleInitialized = false;
    console.log("♻️ Reset puzzle memory (new path next).");
}

function ensureCandidates(){
    if (!puzzleInitialized || candidates.length === 0){
        buildCandidatesForCurrentSkill();
    }
}

// -------- Elimination logic for this puzzle --------

// On OK at step idx with move dir:
//   keep ONLY candidates whose moves[step] == dir
function confirmOnOk(step, dir){
    const before = candidates.length;
    candidates = candidates.filter(c => step < c.moves.length && c.moves[step] === dir);
    console.log(
        "✔️ OK @ step " + step + " move " + NAME[dir] +
        ": candidates " + before + " → " + candidates.length
    );
}

// On FAIL/CLOSED at step idx with move dir:
//   remove ALL candidates whose moves[step] == dir
function eliminateOnFail(step, dir){
    const before = candidates.length;
    candidates = candidates.filter(c => step >= c.moves.length || c.moves[step] !== dir);
    console.log(
        "❌ FAIL @ step " + step + " move " + NAME[dir] +
        ": candidates " + before + " → " + candidates.length
    );
}

// -------- Direction choice: shortest path first for expected dim --------

function pickDir(step){
    ensureCandidates();

    if (candidates.length === 0){
        console.log("⚠️ No candidates available at step", step);
        return null;
    }

    const expDim = expectedDimFromSkill();

    // Candidates that still have a move at this step
    let viable = candidates.filter(c => step < c.moves.length);
    if (viable.length === 0){
        console.log("⚠️ No candidate has a move at step", step);
        return null;
    }

    // Prefer expected dim if any viable
    let pool = viable.filter(c => c.dim === expDim);
    if (pool.length === 0) pool = viable;

    // Shortest-path-first
    pool.sort(function(a, b){
        return a.moves.length - b.moves.length;
    });

    const chosen = pool[0];
    const dir    = chosen.moves[step];

    console.log(
        "📊 step " + step +
        " | expDim=" + expDim +
        " | poolSize=" + pool.length +
        " | chosen dim=" + chosen.dim +
        " len=" + chosen.moves.length +
        " | move=" + NAME[dir]
    );

    return dir;
}

// ---------------------- Main solving loop ----------------------

while (true){
    ensureCandidates();

    let g = openTrap();
    if (!g){
        sleep(2000);
        continue;
    }

    let step    = 0;
    let solving = true;

    while (solving){
        const dir = pickDir(step);
        if (dir === null){
            // Contradiction → treat as puzzle changed
            totalFailed++;
            resetPuzzleMemory();
            sleep(FAIL_WAIT_MS);
            break;
        }

        const r = press(g, dir);

        if (r.state === "solved"){
            // Last move correct
            confirmOnOk(step, dir);
            totalSolved++;
            const pct = Math.round(100 * totalSolved / (totalSolved + totalFailed));
            console.log(
                "🎉 Solved! Solved=" + totalSolved +
                " Failed=" + totalFailed +
                " (" + pct + "% success)"
            );
            resetPuzzleMemory();          // new puzzle next time
            sleep(SUCCESS_WAIT_MS);
            solving = false;
            break;
        }

        if (r.state === "ok"){
            // Move is correct for THIS puzzle at THIS position
            confirmOnOk(step, dir);
            if (candidates.length === 0){
                // If we somehow eliminated everything on OK, puzzle changed
                console.log("⚠️ Contradiction after OK; puzzle changed.");
                totalFailed++;
                resetPuzzleMemory();
                sleep(FAIL_WAIT_MS);
                solving = false;
                break;
            }
            g = r.g;
            step++;
            continue;
        }

        if (r.state === "fail" || r.state === "closed"){
            // Treat CLOSED with no success as FAIL for this move
            eliminateOnFail(step, dir);
            totalFailed++;
            if (candidates.length === 0){
                console.log("⚠️ All candidates eliminated on FAIL; puzzle changed.");
                resetPuzzleMemory();
            }
            // If some candidates remain, puzzle path is same, but we now know this move is wrong.
            sleep(FAIL_WAIT_MS);
            solving = false;
            break;
        }
    }

    console.log("⏳ Cooling down...");
    sleep(COOLDOWN_MS);
}
