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

const config = loadConfig();
const store = new Store(config.statePath);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
    console.warn(`通知先チャンネル ${plan.subscription.channelId} が見つかりません`);
    return;
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
        const [quakes, tsunamis, eews] = await Promise.all([
          fetchQuakes(10),
          fetchTsunamis(5),
          fetchEews(5),
        ]);
        return { quakes, tsunamis, eews };
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

await registerCommands();
await client.login(config.token);
