/* -----------------------------------------------------------------------------
   Mega Menu CLI - the hands an operator (or a Claude agent working this
   folder) uses when the MegaMenu looks wiped. Everything goes through
   megaMenuGuard.js and shopifyOnboarding.js, the same modules the onboarding
   console uses, so the copies read and written here are the ones the agent
   judges the menu against.

   Shopify's menuUpdate replaces the WHOLE menu, so nothing here writes unless
   told to: "restore" only prints the plan until it is given --apply, and a
   restore only ever ADDS items back - nothing live is moved, renamed or
   removed.

   Usage (from the project root, .env supplies the Shopify and storage keys):
     node tools/megamenu.js status              the live menu against the last
                                                good copy: healthy or not, why,
                                                and what is missing
     node tools/megamenu.js history             the kept copies, newest last
     node tools/megamenu.js diff <source>       what <source> has that the live
                                                menu lacks, and the other way
     node tools/megamenu.js restore <source>    print what a restore would put
                                                back (nothing is written)
     node tools/megamenu.js restore <source> --apply
                                                put it back - one menuUpdate
     node tools/megamenu.js restore <source> --only "A|B" [--apply]
                                                put back only the named links
                                                (titles as "diff" prints them,
                                                separated by |) and leave the
                                                rest of what is missing alone
     node tools/megamenu.js accept [--by name]  "the menu is right as it is
                                                now": the live menu becomes the
                                                last good copy

   <source> is "baseline" (the last good copy), a history name as "history"
   prints it, or a path to a menu JSON file such as
   test/fixtures/megamenu-live.json. An old file is how links lost before the
   agent kept any copy come back - and why --only exists: an old copy also
   holds links Dan removed on purpose since, and those must stay gone.
   -------------------------------------------------------------------------- */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const guard = require("../megaMenuGuard");
const shop = require("../shopifyOnboarding");

function flag(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return null;
  return args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : "";
}

async function liveMenu() {
  const read = await shop.readMegaMenu();
  if (!read.available) throw new Error(`the Mega Menu could not be read: ${read.reason}`);
  return read.menu;
}

// "baseline", a history name, or (when files are allowed) a menu JSON on disk.
async function loadSource(source, { allowFile = false } = {}) {
  if (!source) throw new Error('say which copy: "baseline", or a name from "history".');
  if (source === "baseline") {
    const doc = await guard.loadBaseline();
    if (!doc) throw new Error("there is no baseline yet - nothing has read a healthy menu.");
    return { label: `the baseline (${guard.formatWhen(doc.at)}${doc.by ? `, by ${doc.by}` : ""})`, menu: doc.menu };
  }
  if (allowFile && fs.existsSync(source)) {
    const raw = JSON.parse(fs.readFileSync(source, "utf8"));
    const menu = raw.menu && Array.isArray(raw.menu.items) ? raw.menu : raw;
    if (!Array.isArray(menu.items)) throw new Error(`${source} is not a menu (no "items" array).`);
    return { label: path.basename(source), menu };
  }
  const doc = await guard.loadSnapshot(source);
  if (!doc) throw new Error(`there is no copy named "${source}". Run "history" to list them.`);
  return { label: `${source} (${guard.formatWhen(doc.at)})`, menu: doc.menu };
}

/* Keep every link the live menu still has (the restore places the missing ones
   next to them) and only the missing links named in --only. A name that is not
   among the missing ones is an error rather than a silent no-op, so a typo
   never reads as "restored". */
function keepOnly(sourceMenu, live, names) {
  const norm = (value) => String(value == null ? "" : value).trim().replace(/\s+/g, " ").toLowerCase();
  const want = new Set(names.map(norm).filter(Boolean));
  const { baseline, pairs } = guard.matchMenus(sourceMenu, live);
  const missing = baseline.filter((item) => !pairs.has(item));
  const unknown = names.filter((name) => norm(name) && !missing.some((item) => norm(item.title) === norm(name)));
  if (unknown.length) throw new Error(`not missing from the live menu (check the spelling against "diff"): ${unknown.join(", ")}`);
  const drop = new Set(missing.filter((item) => !want.has(norm(item.title))).map((item) => item.node));
  const prune = (items) => (items || []).filter((node) => !drop.has(node)).map((node) => ({ ...node, items: prune(node.items) }));
  return { ...sourceMenu, items: (sourceMenu.items || []).map((top) => ({ ...top, items: prune(top.items) })) };
}

function printItems(items, { indent = "  " } = {}) {
  for (const item of items) console.log(`${indent}${item.parentTitle} > ${item.title}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "status") {
    const menu = await liveMenu();
    const baseline = await guard.loadBaseline();
    const verdict = guard.assessMenu(menu, baseline);
    console.log(`Live menu: ${verdict.storeCount} store(s) in the Store list.`);
    console.log(
      baseline
        ? `Last good copy: ${guard.summarizeMenu(baseline.menu).storeCount} store(s), ${guard.formatWhen(baseline.at)}${baseline.by ? ` by ${baseline.by}` : ""} (${baseline.reason || "read"}).`
        : "Last good copy: none yet."
    );
    console.log(verdict.healthy ? "Healthy." : `NOT HEALTHY. ${verdict.reasons.join(" ")}`);
    if (verdict.missing.length) {
      console.log(`${verdict.missing.length} item(s) in the last good copy are not in the live menu:`);
      printItems(verdict.missing);
    }
    return;
  }

  if (command === "history") {
    const names = await guard.listHistory();
    for (const name of names) {
      const doc = await guard.loadSnapshot(name);
      const short = name.slice(guard.HISTORY_PREFIX.length).replace(/\.json$/, "");
      console.log(`${short}  ${doc ? `${doc.storeCount} store(s)${doc.by ? `, by ${doc.by}` : ""}` : "(unreadable)"}`);
    }
    console.log(`${names.length} cop${names.length === 1 ? "y" : "ies"} (the newest ${guard.HISTORY_KEEP} are kept)`);
    return;
  }

  if (command === "diff") {
    const source = await loadSource(args[0], { allowFile: true });
    const menu = await liveMenu();
    const lacking = guard.assessMenu(menu, { at: null, menu: source.menu }).missing;
    const extra = guard.assessMenu(source.menu, { at: null, menu }).missing;
    console.log(`${source.label} has ${lacking.length} item(s) the live menu lacks:`);
    printItems(lacking);
    console.log(`The live menu has ${extra.length} item(s) ${source.label} lacks:`);
    printItems(extra);
    return;
  }

  if (command === "restore") {
    const source = await loadSource(args[0], { allowFile: true });
    const apply = args.includes("--apply");
    const only = flag(args, "--only");
    const menu = await liveMenu();
    if (only !== null) {
      const names = only.split("|").map((name) => name.trim()).filter(Boolean);
      if (!names.length) throw new Error('--only needs the link titles, e.g. --only "FN Simple Merch|Heavy Equipment Store".');
      source.menu = keepOnly(source.menu, menu, names);
      source.label = `${source.label} (only ${names.length} named link${names.length === 1 ? "" : "s"})`;
    }
    if (!apply) {
      const plan = shop.planMenuRestore(menu, source.menu);
      console.log(`Restoring from ${source.label} would put back ${plan.restored.length} item(s):`);
      printItems(plan.restored);
      if (plan.skipped.length) {
        console.log(`and could not put back ${plan.skipped.length}:`);
        for (const item of plan.skipped) console.log(`  ${item.title} - ${item.reason}`);
      }
      console.log("Nothing was written. Collections deleted since the copy are checked and skipped on --apply. Add --apply to restore.");
      return;
    }
    await guard.saveSnapshot(menu, { reason: "before-restore", by: "tools/megamenu.js" });
    const result = await shop.restoreMegaMenuItems(source.menu, { onLog: (line) => console.log(line) });
    if (result.applied) {
      await guard.saveSnapshot(result.after, { reason: "after-restore", by: "tools/megamenu.js" });
      await guard.observe(result.after, { reason: "after-restore", by: "tools/megamenu.js", snapshot: false });
    }
    console.log(`Restored ${result.restored.length} item(s) from ${source.label}.`);
    printItems(result.restored);
    for (const item of result.skipped) console.log(`  not restored: ${item.title} - ${item.reason}`);
    return;
  }

  if (command === "accept") {
    const by = flag(args, "--by") || "tools/megamenu.js";
    const menu = await liveMenu();
    const doc = await guard.acceptBaseline(menu, { by, reason: "accepted" });
    console.log(`Accepted the live menu as the last good copy (${guard.summarizeMenu(doc.menu).storeCount} store(s), by ${by}). The previous copy is kept in history.`);
    return;
  }

  throw new Error(`Unknown command "${command || ""}". See the usage block at the top of tools/megamenu.js.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
