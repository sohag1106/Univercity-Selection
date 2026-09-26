/* Smoke test for index.html — run: node webapp/_smoke_test.js
   Stubs document/localStorage, loads the inline script in a vm context,
   then asserts evaluate()/render() behaviour. */
const fs = require("fs"), path = require("path"), vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* --- minimal DOM stub --- */
const els = {};
function el(id) {
  if (els[id]) return els[id];
  const e = {
    id, value: "", textContent: "", innerHTML: "", dataset: {},
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener() {}, insertAdjacentHTML() {},
    classList: { contains() { return false; } },
    closest() { return null; },
    filter: null,
  };
  els[id] = e; return e;
}
const store = {};
const sandbox = {
  console, Date, Math, JSON, RegExp, Array, Object, String, Number,
  parseFloat, parseInt, isNaN, encodeURIComponent, setTimeout,
  document: { getElementById: el },
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  },
};
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: "index-inline.js" });

/* --- probe inside the same context (top-level const/let live there) --- */
vm.runInContext(`
globalThis.__probe = () => {
  const ids = P.map(p => p.id);
  const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
  const ev = id => evaluate(P.find(p => p.id === id));
  const gates = id => ev(id).gates;

  // verdict per key programme
  const V = {};
  ["passau-cs","passau-aie","do-ds","muen-ds","mann-wi","fuas-it","thi-ai","hfu-aim",
   "thws-ai","lue-ras","aug-ds","oth-aw","sie-hci","haw-ice","albsig-iai",
   "wue-cs","ulm-cit","thu-is","pot-cs","fau-ds","fau-at","osn-cogsci",
   "harz-tim","hawkiel-cs","hhu-aids",
   "lue-its","anhalt-mme","fuas-his","heis-aai","heis-se"].forEach(id => {
    const r = ev(id); V[id] = { v: r.verdict, fails: r.fails.slice(), gateFail: r.gates.filter(g=>!g.ok).map(g=>g.label) };
  });

  // render orders with/without moiFirst, and moiOnly filtering
  const count = () => (document.getElementById("list").innerHTML.match(/<article /g) || []).length;
  const firstMoi = () => {
    const h = document.getElementById("list").innerHTML;
    const first = h.split("</article>")[0];
    for (const t of ["MOI accepted","MOI case-by-case","MOI unclear","MOI refused","MOI not accepted"])
      if (first.includes(t)) return t;
    return "?";
  };
  const moiRankTxt = t => ({"MOI accepted":0,"MOI case-by-case":1,"MOI unclear":1,"MOI refused":2,"MOI not accepted":2}[t]);

  const base = { ...S };
  S.moiOnly = false; S.showBlocked = false; S.tab = "all"; S.moiFirst = false; render();
  const orderNoSort = firstMoi(), nNoSort = count();
  S.moiFirst = true; render();
  const orderSort = firstMoi(), nSort = count();
  S.moiOnly = true; render();
  const nOnly = count();
  const onlyH = document.getElementById("list").innerHTML;
  const onlyBad = onlyH.split("<article ").some(chunk =>
    chunk.includes("MOI refused") || chunk.includes("MOI not accepted"));
  const stats = document.getElementById("stats").innerHTML;
  const hint = document.getElementById("ectsHint").innerHTML;

  // XSS: a hostile remark must render escaped
  S.moiOnly = false;
  M.notes["lue-ras"] = '<img src=x onerror=alert(1)>';
  render();
  const xssEscaped = document.getElementById("list").innerHTML.includes("&lt;img src=x onerror=alert(1)&gt;")
    && !document.getElementById("list").innerHTML.includes('<img src=x onerror=alert(1)');

  Object.assign(S, base); render();

  // shortlist seed: the 12 ✅-fits + sweep adds must arrive on a fresh browser
  const shortCnt = document.getElementById("shortCnt").textContent;
  S.tab = "short"; render();
  const nShort = (document.getElementById("list").innerHTML.match(/<article /g) || []).length;
  const shortMissing = REC.filter(id => !M.ids.includes(id));
  const recPersisted = (() => { try { const o = JSON.parse(localStorage.getItem("ssf-marks-v1")); return o && o.recV === 3 && Array.isArray(o.ids); } catch (e) { return false; } })();
  const seededNote = (() => { try { const o = JSON.parse(localStorage.getItem("ssf-marks-v1")); return (o && o.notes && o.notes["lue-ras"]) || ""; } catch (e) { return ""; } })();
  const seededNoteIts = (() => { try { const o = JSON.parse(localStorage.getItem("ssf-marks-v1")); return (o && o.notes && o.notes["lue-its"]) || ""; } catch (e) { return ""; } })();
  const seededNoteHarz = (() => { try { const o = JSON.parse(localStorage.getItem("ssf-marks-v1")); return (o && o.notes && o.notes["harz-tim"]) || ""; } catch (e) { return ""; } })();
  S.tab = "all"; render();

  return { n: P.length, dupes, V, orderNoSort, orderSort, moiRankTxt,
           nNoSort, nSort, nOnly, onlyBad, stats, hint, xssEscaped,
           dlLue: dl(P.find(p => p.id === "lue-ras")),
           shortCnt, nShort, shortMissing, recPersisted, seededNote,
           seededNoteIts, seededNoteHarz };
};
`, ctx);

const r = vm.runInContext("__probe()", ctx);
let fails = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log("  ✓ " + label);
  else { fails++; console.log("  ✗ " + label + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("\n[structure]");
ok(r.n >= 60, `record count ${r.n} ≥ 60`);
ok(r.dupes.length === 0, "no duplicate ids", r.dupes);

console.log("\n[ECTS gates vs transcript]");
ok(r.V["passau-cs"].v !== "r", "Passau CS (110 ECTS) → not blocked", r.V["passau-cs"]);
ok(r.V["passau-cs"].gateFail.length === 0, "Passau CS gate passes", r.V["passau-cs"].gateFail);
ok(r.V["passau-aie"].v === "r" && r.V["passau-aie"].gateFail.includes("Maths (incl. theoretical CS)"),
   "Passau AIE (35 maths, you 33) → BLOCKED by gate", r.V["passau-aie"]);
ok(r.V["do-ds"].gateFail.length === 0 && r.V["do-ds"].v !== "r",
   "Dortmund DS 16/4/8 → gates pass", r.V["do-ds"]);
ok(r.V["muen-ds"].gateFail.length === 0 && r.V["muen-ds"].v !== "r",
   "Münster DS (120 LP) → gate passes", r.V["muen-ds"]);
ok(r.V["mann-wi"].v === "r" && r.V["mann-wi"].gateFail.includes("Business/BWI"),
   "Mannheim WI (30 business, you 9) → BLOCKED by gate", r.V["mann-wi"]);
ok(["fuas-it","thi-ai","hfu-aim"].every(id => r.V[id].gateFail.length === 0),
   "210-ECTS floors (Frankfurt/THI/Furtwangen) pass at 234");
ok(r.V["thws-ai"].gateFail.length === 0 && r.V["thws-ai"].v !== "r",
   "THWS AI 210/20/15 gates pass", r.V["thws-ai"]);

console.log("\n[new records verdicts]");
ok(r.V["lue-ras"].v !== "r", "Lübeck RAS → not blocked", r.V["lue-ras"]);
ok(r.V["aug-ds"].v !== "r", "Augsburg DS → not blocked", r.V["aug-ds"]);
ok(r.V["oth-aw"].v !== "r", "OTH Amberg-Weiden AI → not blocked", r.V["oth-aw"]);
ok(r.V["sie-hci"].v !== "r" && r.V["sie-hci"].fails.every(f => !/IELTS|Reading/.test(f)),
   "Siegen HCI → MOI case route clears 6.5 test", r.V["sie-hci"]);
ok(r.V["haw-ice"].v === "a", "HAW ICE → amber (borderline 150 CP gate flagged as cond)", r.V["haw-ice"]);
ok(r.V["albsig-iai"].v === "a", "Albstadt IAI → amber (unpublished MOI)", r.V["albsig-iai"]);
ok(r.V["wue-cs"].gateFail.length === 0 && r.V["wue-cs"].v !== "r",
   "Würzburg CS 180/100/25 gates pass", r.V["wue-cs"]);
ok(r.V["ulm-cit"].v !== "r", "Ulm CIT → not blocked (MOI clears C1; subject gate as cond)", r.V["ulm-cit"]);
ok(r.V["thu-is"].gateFail.length === 0 && r.V["thu-is"].v !== "r",
   "THU Intelligent Systems 210/60 gates pass", r.V["thu-is"]);
ok(r.V["pot-cs"].v === "r" && r.V["pot-cs"].fails.includes("GRE required"),
   "Potsdam CS → BLOCKED on GRE", r.V["pot-cs"]);
ok(r.V["fau-ds"].v !== "r" && r.V["fau-at"].v !== "r", "FAU DS + Autonomy → not blocked", r.V["fau-ds"]);
ok(r.V["osn-cogsci"].v !== "r" && r.V["osn-cogsci"].gateFail.length === 0,
   "Osnabrück Cognitive Science → not blocked, 180 gate passes", r.V["osn-cogsci"]);
ok(r.V["harz-tim"].v !== "r", "Harz TIM → not blocked (new viable from list sweep)", r.V["harz-tim"]);
ok(r.V["hawkiel-cs"].v === "r" && r.V["hawkiel-cs"].fails.includes("GRE required"),
   "HAW Kiel CS → BLOCKED on GRE", r.V["hawkiel-cs"]);
ok(r.V["hhu-aids"].v === "r", "HHU AI & Data Science → blocked (winter-only + 30-ECTS maths gate)", r.V["hhu-aids"]);

console.log("\n[list sweep part 2]");
ok(r.V["lue-its"].v !== "r" && r.V["lue-its"].gateFail.length === 0,
   "Lübeck IT Security → not blocked, 60-CP basic-CS gate passes", r.V["lue-its"]);
ok(r.V["anhalt-mme"].v === "r" && r.V["anhalt-mme"].fails.some(f => /Needs grade/.test(f)),
   "Anhalt Media Engineering → BLOCKED on grade 2.0 cut-off", r.V["anhalt-mme"]);
ok(r.V["fuas-his"].v === "r" && r.V["fuas-his"].fails.some(f => /summer|grade/.test(f)),
   "Frankfurt High Integrity Systems → BLOCKED (winter-only + 1.8 floor)", r.V["fuas-his"]);
ok(r.V["heis-aai"].v === "r" && r.V["heis-aai"].fails.some(f => /IELTS 6\.0/.test(f)),
   "Heilbronn Applied AI → BLOCKED on IELTS 6.0", r.V["heis-aai"]);
ok(r.V["heis-se"].v === "r" && r.V["heis-se"].fails.some(f => /IELTS 6\.0/.test(f)),
   "Heilbronn SE → BLOCKED on IELTS 6.0 (and no longer conflates Applied AI)", r.V["heis-se"]);

console.log("\n[MOI-first / MOI-only]");
ok(r.nSort > 0 && r.nOnly <= r.nSort, `moiOnly filters ${r.nSort} → ${r.nOnly} cards`);
ok(r.onlyBad === false, "moiOnly shows no MOI-refused/not-accepted cards");
ok(r.orderSort === "MOI accepted", "with moiFirst, top card is MOI-accepted", r.orderSort);
ok(r.moiRankTxt(r.orderSort) <= r.moiRankTxt(r.orderNoSort),
   `moiFirst improves top-card MOI rank (${r.orderNoSort} → ${r.orderSort})`);
ok(r.stats.includes("MOI-accepted"), "stats line shows MOI-accepted count");
ok(r.hint.includes("234 ECTS"), "ECTS hint shows transcript totals");

console.log("\n[shortlist seed — 12 fits + Lübeck×2 + Harz]");
ok(Number(r.shortCnt) === 14, `header shortlist counter = ${r.shortCnt}`, r.shortCnt);
ok(r.nShort === 14, `shortlist tab renders ${r.nShort} cards`, r.nShort);
ok(r.shortMissing.length === 0, "every REC id landed in M.ids", r.shortMissing);
ok(r.recPersisted === true, "seed persisted with recV=3 (future unticks stick)");
ok(r.seededNote.includes("Prüfungsausschuss"), "Lübeck RAS remark pre-filled with the 32-ECTS question", r.seededNote);
ok(r.seededNoteIts.includes("12 CP security") && r.seededNoteIts.includes("15 Oct 2026"),
   "Lübeck IT-Security remark pre-filled (gates + window)", r.seededNoteIts);
ok(r.seededNoteHarz.includes("15 Dec 2026") && r.seededNoteHarz.includes("professional experience"),
   "Harz TIM remark pre-filled (deadline + experience check)", r.seededNoteHarz);

console.log("\n[safety]");
ok(r.xssEscaped === true, "hostile remark renders escaped");
ok(/Opens in|Closes in|Open now|Last day/.test(r.dlLue), "Lübeck deadline renders", r.dlLue);

console.log(fails ? `\n${fails} FAILED\n` : "\nALL PASS\n");
process.exit(fails ? 1 : 0);
