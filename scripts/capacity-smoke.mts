// Tile assignment when sessions outnumber tiles. Run with `npx tsx scripts/capacity-smoke.mts`.
import { SessionStore } from "../src/state.js";

function assert(cond: unknown, msg: string): void {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
}

const store = new SessionStore();
const shown = () => store.visible().map((s) => s.id).join(",");

// One tile. A finished session holds it; a newer one starts working.
store.upsert("old", "/tmp/old");
store.apply("old", { state: "done", lastEvent: "Stop" });
store.reconcileCapacity(1);
store.upsert("new", "/tmp/new");
store.apply("new", { state: "working", lastEvent: "PreToolUse" });
store.reconcileCapacity(1);
assert(shown() === "new", `working session should take the tile from a done one, got "${shown()}"`);

// Same band: no swap back, however often we reconcile.
store.apply("new", { state: "done", lastEvent: "Stop" });
for (let i = 0; i < 5; i++) store.reconcileCapacity(1);
assert(shown() === "new", `equal-priority sessions must not trade places, got "${shown()}"`);

// A session waiting on the user outranks one that's working.
store.apply("new", { state: "working", lastEvent: "PreToolUse" });
store.apply("old", { state: "waiting", lastEvent: "PermissionRequest" });
store.reconcileCapacity(1);
assert(shown() === "old", `waiting session should take the tile, got "${shown()}"`);

// A SessionStart-only session can't be shown (visible() hides it), so it must
// never evict a real one and leave the tile blank.
store.apply("old", { state: "done", lastEvent: "Stop" });
store.upsert("ghost", "/tmp/ghost");
store.apply("ghost", { state: "waiting", lastEvent: "SessionStart", overflow: true });
store.reconcileCapacity(1);
assert(shown() === "new", `the working session, not the hidden ghost, should take the tile, got "${shown()}"`);
store.apply("old", { state: "waiting", lastEvent: "PermissionRequest" });
store.reconcileCapacity(1);

// Enough tiles: everyone is shown and nothing is evicted.
store.reconcileCapacity(2);
assert(store.visible().length === 2 && store.overflowList().length === 0, "two tiles should show both sessions");

console.log("capacity-smoke: ok");
