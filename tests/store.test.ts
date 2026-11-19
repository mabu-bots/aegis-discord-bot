// ===== テスト: ストアの破損復旧と型検証 =====
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";

function tmpStorePath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "aegis-bot-store-test-"));
  return { dir, path: join(dir, "state.json") };
}

test("Store: 破損した状態ファイルは別名へ退避され、空の状態で起動する", () => {
  const { dir, path } = tmpStorePath();
  writeFileSync(path, "{ これは壊れた JSON", "utf-8");
  const store = new Store(path);
  assert.deepEqual(store.data.subscriptions, []);
  assert.equal(store.data.primed, false);
  const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]), "utf-8"), "{ これは壊れた JSON");
  // 退避後は通常どおり保存できる
  store.save();
  const reopened = new Store(path);
  assert.equal(reopened.data.primed, false);
  rmSync(dir, { recursive: true, force: true });
});

test("Store: JSON として読めてもオブジェクトでなければ破損として退避する", () => {
  const { dir, path } = tmpStorePath();
  writeFileSync(path, "[1,2,3]", "utf-8");
  const store = new Store(path);
  assert.deepEqual(store.data.subscriptions, []);
  assert.equal(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("Store: フィールドごとに型検証し、正しい要素だけ採用する", () => {
  const { dir, path } = tmpStorePath();
  writeFileSync(
    path,
    JSON.stringify({
      subscriptions: [
        { guildId: "g", channelId: "c", minScale: 30, eew: true, strongMention: false },
        { guildId: "g", channelId: 123, minScale: 30, eew: true, strongMention: false },
        { guildId: "g", channelId: "c2", minScale: "30", eew: true, strongMention: false },
        "not-an-object",
      ],
      seenQuakes: { q1: 40, q2: "45" },
      seenTsunamis: ["t1", 42, "t2"],
      // 旧形式 (boolean) の EEW 記録は型検証で破棄される
      seenEews: { e1: true, e2: 45 },
      primed: "yes",
    }),
    "utf-8",
  );
  const store = new Store(path);
  assert.equal(store.data.subscriptions.length, 1);
  assert.equal(store.data.subscriptions[0].channelId, "c");
  assert.deepEqual(store.data.seenQuakes, { q1: 40 });
  assert.deepEqual(store.data.seenTsunamis, ["t1", "t2"]);
  assert.deepEqual(store.data.seenEews, { e2: 45 });
  assert.equal(store.data.primed, false);
  // 形の崩れだけでは退避しない (パース自体は成功しているため)
  assert.equal(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length, 0);
  rmSync(dir, { recursive: true, force: true });
});
