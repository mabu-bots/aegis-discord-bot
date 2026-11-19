// ===== テスト: コマンドハンドラの権限チェックと確認文 =====
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import { handleCommand } from "../src/commands.js";
import { Store } from "../src/store.js";

interface FakeReply {
  content?: string;
  ephemeral?: boolean;
}

function fakeInteraction(
  commandName: string,
  canManage: boolean,
  replies: FakeReply[],
): ChatInputCommandInteraction {
  const fake = {
    commandName,
    guildId: "g1",
    channelId: "c1",
    channel: { type: ChannelType.GuildText },
    memberPermissions: { has: () => canManage },
    options: {
      getString: () => "30",
      getBoolean: (name: string) => (name === "strong_mention" ? true : true),
    },
    reply: async (o: FakeReply) => {
      replies.push(o);
    },
  };
  return fake as unknown as ChatInputCommandInteraction;
}

function tmpStore(): { dir: string; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "aegis-bot-cmd-test-"));
  return { dir, store: new Store(join(dir, "state.json")) };
}

test("/watch: ManageGuild がない実行者はハンドラ側で拒否され、登録もされない", async () => {
  const { dir, store } = tmpStore();
  const replies: FakeReply[] = [];
  await handleCommand(fakeInteraction("watch", false, replies), store);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content ?? "", /ManageGuild/);
  assert.equal(store.data.subscriptions.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("/unwatch: ManageGuild がない実行者はハンドラ側で拒否される", async () => {
  const { dir, store } = tmpStore();
  store.upsertSubscription({ guildId: "g1", channelId: "c1", minScale: 30, eew: true, strongMention: false });
  const replies: FakeReply[] = [];
  await handleCommand(fakeInteraction("unwatch", false, replies), store);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content ?? "", /ManageGuild/);
  // 解除されていないこと
  assert.equal(store.data.subscriptions.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("/watch: 権限があれば登録され、strong_mention 時は Mention Everyone 権限の注記が付く (H-3)", async () => {
  const { dir, store } = tmpStore();
  const replies: FakeReply[] = [];
  await handleCommand(fakeInteraction("watch", true, replies), store);
  assert.equal(store.data.subscriptions.length, 1);
  assert.equal(store.data.subscriptions[0].strongMention, true);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content ?? "", /Mention Everyone/);
  rmSync(dir, { recursive: true, force: true });
});
