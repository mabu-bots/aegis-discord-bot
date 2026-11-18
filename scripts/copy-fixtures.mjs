// テスト用フィクスチャ (JSON) を dist へコピーする。
// tsc は .json をコピーしないため、テスト実行前に明示的にコピーする。
import { cpSync } from "node:fs";

cpSync(new URL("../tests/fixtures", import.meta.url), new URL("../dist/tests/fixtures", import.meta.url), {
  recursive: true,
});
console.log("フィクスチャを dist/tests/fixtures へコピーしました");
