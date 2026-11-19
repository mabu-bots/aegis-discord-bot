// ===== 7. スラッシュコマンド =====
import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { quakeEmbed, weatherEmbed } from "./embeds.js";
import { scaleLabel, DEFAULT_PLACES } from "./sources/p2p.js";
import { fetchQuakes } from "./sources/p2p.js";
import { fetchWeather, geocode } from "./sources/weather.js";
import type { Store } from "./store.js";

// ----- 7.1 定義 -----
export const commandBuilders = [
  new SlashCommandBuilder()
    .setName("quake")
    .setDescription("最新の地震情報を表示します"),
  new SlashCommandBuilder()
    .setName("weather")
    .setDescription("天気予報を表示します (場所を省略すると高崎と大宮)")
    .addStringOption((o) =>
      o.setName("place").setDescription("地名 (例: 前橋、東京、仙台)").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("このチャンネルを地震・津波・EEW の通知先に登録します")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName("min_scale")
        .setDescription("通知する最小震度 (既定: 震度3)")
        .setRequired(false)
        .addChoices(
          { name: "震度1", value: "10" },
          { name: "震度2", value: "20" },
          { name: "震度3", value: "30" },
          { name: "震度4", value: "40" },
          { name: "震度5弱", value: "45" },
        ),
    )
    .addBooleanOption((o) =>
      o.setName("eew").setDescription("緊急地震速報も通知する (既定: する)").setRequired(false),
    )
    .addBooleanOption((o) =>
      o
        .setName("strong_mention")
        .setDescription("震度5弱以上で @everyone を付ける (既定: 付けない)")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("unwatch")
    .setDescription("このチャンネルの通知登録を解除します")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("watchlist")
    .setDescription("このサーバーの通知登録状況を表示します"),
];

export const commandData = commandBuilders.map((b) => b.toJSON());

// ----- 7.2 ハンドラ -----
// 管理系コマンドは宣言 (setDefaultMemberPermissions) だけでなくハンドラ側でも
// 明示チェックする (インテグレーション権限を上書きされた構成への多層防御)
function hasManageGuild(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function denyWithoutManageGuild(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (hasManageGuild(interaction)) return false;
  await interaction.reply({
    content: "このコマンドの実行にはサーバー管理権限 (ManageGuild) が必要です。",
    ephemeral: true,
  });
  return true;
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  switch (interaction.commandName) {
    case "quake":
      return handleQuake(interaction);
    case "weather":
      return handleWeather(interaction);
    case "watch":
      return handleWatch(interaction, store);
    case "unwatch":
      return handleUnwatch(interaction, store);
    case "watchlist":
      return handleWatchlist(interaction, store);
  }
}

async function handleQuake(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const quakes = await fetchQuakes(5);
  if (quakes.length === 0) {
    await interaction.editReply("地震情報を取得できませんでした。");
    return;
  }
  const [latest, ...rest] = quakes;
  const lines = rest.map(
    (q) => `・${q.time} 最大震度${scaleLabel(q.maxScale)} ${q.hypocenter} (${q.magnitude === null ? "M不明" : `M${q.magnitude}`})`,
  );
  await interaction.editReply({
    content: lines.length > 0 ? `**最近の地震**\n${lines.join("\n")}` : undefined,
    embeds: [quakeEmbed(latest)],
  });
}

async function handleWeather(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const place = interaction.options.getString("place");
  if (!place) {
    const reports = await Promise.all(
      DEFAULT_PLACES.map((p) => fetchWeather(p.lat, p.lon, p.name)),
    );
    await interaction.editReply({ embeds: reports.map((r) => weatherEmbed(r)) });
    return;
  }
  const geo = await geocode(place);
  if (!geo) {
    // ユーザー入力を公開返信へ埋め込むため、メンションとして発火しないよう制限する
    await interaction.editReply({
      content: `「${place}」という地名が見つかりませんでした。`,
      allowedMentions: { parse: [] },
    });
    return;
  }
  const report = await fetchWeather(geo.lat, geo.lon, geo.displayName);
  await interaction.editReply({ embeds: [weatherEmbed(report)] });
}

async function handleWatch(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  if (await denyWithoutManageGuild(interaction)) return;
  if (!interaction.guildId || !interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "テキストチャンネルで実行してください。", ephemeral: true });
    return;
  }
  const minScale = Number(interaction.options.getString("min_scale") ?? "30");
  const eew = interaction.options.getBoolean("eew") ?? true;
  const strongMention = interaction.options.getBoolean("strong_mention") ?? false;
  store.upsertSubscription({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    minScale,
    eew,
    strongMention,
  });
  await interaction.reply({
    content:
      `このチャンネルを通知先に登録しました。\n` +
      `・地震: 震度${scaleLabel(minScale)}以上\n` +
      `・津波: すべて (解除を含む)\n` +
      `・緊急地震速報: ${eew ? "通知する" : "通知しない"}\n` +
      `・震度5弱以上での @everyone: ${strongMention ? "付ける" : "付けない"}` +
      (strongMention
        ? `\n※ @everyone を実際に ping するには、Bot に「全員にメンション (Mention Everyone)」権限が必要です。`
        : ``),
    ephemeral: true,
  });
}

async function handleUnwatch(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  if (await denyWithoutManageGuild(interaction)) return;
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
    return;
  }
  const removed = store.removeSubscription(interaction.guildId, interaction.channelId);
  await interaction.reply({
    content: removed
      ? "このチャンネルの通知登録を解除しました。"
      : "このチャンネルは通知先に登録されていません。",
    ephemeral: true,
  });
}

async function handleWatchlist(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
    return;
  }
  const subs = store.subscriptionsForGuild(interaction.guildId);
  if (subs.length === 0) {
    await interaction.reply({ content: "通知先はまだ登録されていません。", ephemeral: true });
    return;
  }
  const lines = subs.map(
    (s) =>
      `・<#${s.channelId}>: 震度${scaleLabel(s.minScale)}以上 / EEW ${s.eew ? "あり" : "なし"} / 強震メンション ${s.strongMention ? "あり" : "なし"}`,
  );
  await interaction.reply({ content: `**通知登録状況**\n${lines.join("\n")}`, ephemeral: true });
}
