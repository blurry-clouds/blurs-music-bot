require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { LavalinkManager } = require("lavalink-client");

process.on("unhandledRejection", (r) => console.error("UNHANDLED_REJECTION:", r));
process.on("uncaughtException", (e) => console.error("UNCAUGHT_EXCEPTION:", e));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.lavalink = new LavalinkManager({
  nodes: [
    {
      authorization: process.env.LAVALINK_PASSWORD,
      host: process.env.LAVALINK_HOST,
      port: Number(process.env.LAVALINK_PORT),
      id: "local",
      secure: false,
      retryAmount: 10,
      retryDelay: 5_000,
    },
  ],
  sendToShard: (guildId, payload) =>
    client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true,
  client: { id: process.env.CLIENT_ID },
  playerOptions: {
    defaultSearchPlatform: process.env.SEARCH_SOURCE || "scsearch",
    onEmptyQueue: { destroyAfterMs: 30_000 },
    onDisconnect: { autoReconnect: true, destroyPlayer: false },
  },
});

client.on("raw", (d) => client.lavalink.sendRawData(d));

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.lavalink.init({ ...client.user });
});

client.lavalink.nodeManager?.on?.("connect", (node) =>
  console.log(`🟩 Lavalink connected: ${node.id}`)
);
client.lavalink.on("trackStart", (player, track) =>
  console.log(`▶️ trackStart guild=${player.guildId} title=${track?.info?.title}`)
);
client.lavalink.on("trackError", (player, track, payload) => {
  console.log(`💥 trackError guild=${player.guildId} title=${track?.info?.title}`);
  console.log(payload?.exception?.message || payload);
});

async function safeDefer(interaction) {
  if (interaction.deferred || interaction.replied) return true;
  try { await interaction.deferReply(); return true; } catch { return false; }
}
async function safeEdit(interaction, content) {
  try { await interaction.editReply(content); } catch (e) { console.error("editReply failed:", e?.code || e); }
}
async function safeReply(interaction, content) {
  try { await interaction.reply({ content, ephemeral: true }); } catch (e) { console.error("reply failed:", e?.code || e); }
}

function getVoiceChannelId(interaction) {
  return interaction.member?.voice?.channelId || null;
}

async function getOrCreatePlayer(interaction) {
  const guildId = interaction.guildId;
  const voiceChannelId = getVoiceChannelId(interaction);
  if (!voiceChannelId) return { player: null, error: "Join a voice channel first." };

  let player = client.lavalink.getPlayer(guildId);
  if (!player) {
    player = client.lavalink.createPlayer({
      guildId,
      voiceChannelId,
      textChannelId: interaction.channelId,
      selfDeaf: true,
      volume: 100,
    });
  }
  await player.connect();
  return { player, error: null };
}

function pickSource(raw) {
  const q = raw.trim();
  if (q.toLowerCase().startsWith("yt:")) return { source: "ytsearch", query: q.slice(3).trim() };
  if (q.toLowerCase().startsWith("sc:")) return { source: "scsearch", query: q.slice(3).trim() };
  return { source: process.env.SEARCH_SOURCE || "scsearch", query: q };
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "join") {
      const { error } = await getOrCreatePlayer(interaction);
      if (error) return safeReply(interaction, `❌ ${error}`);
      return interaction.reply("✅ Joined your voice channel.");
    }

    if (interaction.commandName === "play") {
      const ok = await safeDefer(interaction);
      if (!ok) return;

      const { player, error } = await getOrCreatePlayer(interaction);
      if (error) return safeEdit(interaction, `❌ ${error}`);

      const raw = interaction.options.getString("query", true);
      const { source, query } = pickSource(raw);

      console.log(`🔎 search source=${source} query="${query}"`);
      const res = await player.search({ query, source }, interaction.user);
      const track = res?.tracks?.[0];
      if (!track) return safeEdit(interaction, "❌ No results found.");

      player.queue.add(track);
      if (!player.playing) await player.play();

      return safeEdit(interaction, `🎶 Queued: **${track.info.title}**`);
    }

    if (interaction.commandName === "skip") {
      const player = client.lavalink.getPlayer(interaction.guildId);
      if (!player) return safeReply(interaction, "❌ Nothing is playing.");
      await player.skip();
      return interaction.reply("⏭️ Skipped.");
    }

    if (interaction.commandName === "stop") {
      const player = client.lavalink.getPlayer(interaction.guildId);
      if (!player) return safeReply(interaction, "❌ No player active.");
      await player.destroy();
      return interaction.reply("🛑 Stopped and left voice.");
    }
  } catch (err) {
    console.error("ERR:", err);
    if (interaction.deferred || interaction.replied) return safeEdit(interaction, "❌ Error. Check VPS logs.");
    return safeReply(interaction, "❌ Error. Check VPS logs.");
  }
});

client.login(process.env.DISCORD_TOKEN);
