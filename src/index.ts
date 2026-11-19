// ===== 8. エントリポイント =====
// Discord へログインし、コマンド登録・対話処理・監視ループを開始する。
// 特権インテントは使わない (Guilds のみ)。
import { Client, Events, GatewayIntentBits, REST, Routes, type TextChannel } from "discord.js";
import { commandData, handleCommand } from "./commands.js";
import { loadConfig } from "./config.js";
import { eewEmbed, quakeEmbed, tsunamiEmbed } from "./embeds.js";
import { Monitor, type PlannedMessage } from "./monitor.js";
import { scaleLabel } from "./sources/p2p.js";
import { fetchEews, fetchQuakes, fetchTsunamis } from "./sources/p2p.js";
import { Store } from "./store.js";
import { attachReadyWatchdog } from "./watchdog.js";

const config = loadConfig();
const store = new Store(config.statePath);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Gateway安全構造: READY が来ないサイレント停滞を検知して終了する (watchdog.ts)
attachReadyWatchdog(client);

// ----- 8.1 コマンド登録 (起動時に自動) -----
async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.token);
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
      body: commandData,
    });
    console.log(`コマンドをギルド ${config.guildId} に登録しました`);
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body: commandData });
    console.log("コマンドをグローバルに登録しました");
  }
}

// ----- 8.2 通知の送信 -----
async function sendPlanned(plan: PlannedMessage): Promise<void> {
  const channel = await client.channels.fetch(plan.subscription.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    // 正常 return すると Monitor 側で成功扱いになり再試行されないため、例外にする
    throw new Error(`通知先チャンネル ${plan.subscription.channelId} が見つかりません`);
  }
  const textChannel = channel as TextChannel;
  const alert = plan.alert;
  if (alert.kind === "quake") {
    const mention =
      plan.subscription.strongMention && alert.maxScale >= 45 ? "@everyone" : undefined;
    await textChannel.send({ content: mention, embeds: [quakeEmbed(alert, plan.isUpdate)] });
  } else if (alert.kind === "tsunami") {
    const mention =
      plan.subscription.strongMention && (alert.grade === "Warning" || alert.grade === "MajorWarning")
        ? "@everyone"
        : undefined;
    await textChannel.send({ content: mention, embeds: [tsunamiEmbed(alert)] });
  } else {
    await textChannel.send({ embeds: [eewEmbed(alert, plan.arrivalLines)] });
  }
  const label =
    alert.kind === "quake"
      ? `地震 最大震度${scaleLabel(alert.maxScale)} ${alert.hypocenter}`
      : alert.kind === "tsunami"
        ? "津波情報"
        : `EEW ${alert.hypocenter}`;
  console.log(`通知しました: ${label} -> #${plan.subscription.channelId}`);
}

// ----- 8.3 起動 -----
client.once(Events.ClientReady, (c) => {
  console.log(`ログインしました: ${c.user.tag} / 通知登録 ${store.data.subscriptions.length} 件`);
  const monitor = new Monitor(
    {
      store,
      fetchAll: async () => {
        // 1 つの情報源の失敗で成功した残りまで破棄しないよう allSettled で個別に扱う
        const [quakes, tsunamis, eews] = await Promise.allSettled([
          fetchQuakes(10),
          fetchTsunamis(5),
          fetchEews(5),
        ]);
        const names = ["地震情報", "津波情報", "緊急地震速報"];
        const results = [quakes, tsunamis, eews];
        results.forEach((r, i) => {
          if (r.status === "rejected") {
            console.warn(
              `${names[i]}の取得に失敗しました: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
            );
          }
        });
        // 全滅したときだけ例外にして Monitor 側のバックオフを効かせる
        if (results.every((r) => r.status === "rejected")) {
          const first = results[0];
          throw first.status === "rejected" ? first.reason : new Error("情報の取得に失敗しました");
        }
        return {
          quakes: quakes.status === "fulfilled" ? quakes.value : [],
          tsunamis: tsunamis.status === "fulfilled" ? tsunamis.value : [],
          eews: eews.status === "fulfilled" ? eews.value : [],
        };
      },
      send: sendPlanned,
      log: (msg) => console.warn(msg),
    },
    config.pollSeconds,
  );
  monitor.start();
  console.log(`監視を開始しました (${config.pollSeconds} 秒間隔)`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction, store);
  } catch (err) {
    console.error("コマンド処理でエラーが発生しました:", err);
    const msg = "処理中にエラーが発生しました。時間をおいて再度お試しください。";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => undefined);
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => undefined);
    }
  }
});

// コマンド登録の失敗 (レート制限等) で Bot 全体を落とさない: ログに留めてログインを続行する
try {
  await registerCommands();
} catch (err) {
  console.error("コマンド登録に失敗しましたが、Bot のログインは続行します:", err);
}
await client.login(config.token);
