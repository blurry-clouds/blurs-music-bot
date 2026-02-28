require("dotenv").config();
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  EmbedBuilder,
  GatewayIntentBits,
  StringSelectMenuBuilder,
} = require("discord.js");
const { LavalinkManager } = require("lavalink-client");
const {
  SEARCH_CACHE_TTL_MS,
  makeSearchCacheKey,
  setSearchCache,
  getSearchCache,
  deleteSearchCache,
} = require("./searchCache");

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

async function getOrCreatePlayer(interaction, options = {}) {
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
  if (options.connect !== false) await player.connect();
  return { player, error: null };
}

function pickSource(raw) {
  const q = raw.trim();
  if (q.toLowerCase().startsWith("yt:")) return { source: "ytsearch", query: q.slice(3).trim() };
  if (q.toLowerCase().startsWith("sc:")) return { source: "scsearch", query: q.slice(3).trim() };
  return { source: process.env.SEARCH_SOURCE || "scsearch", query: q };
}

const SELECT_PREFIX = "play_select:";
const BTN_ADD5_PREFIX = "play_add5:";
const BTN_ADD10_PREFIX = "play_add10:";
const BTN_SHUFFLE_PREFIX = "play_shuffle:";
const BTN_CANCEL_PREFIX = "play_cancel:";
const COMPONENT_TIMEOUT_MS = 60_000;
const MAX_MENU_RESULTS = 10;

function truncate(text, maxLen) {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "Live / Unknown";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildSelectRow(cacheKey, tracks) {
  const options = tracks.map((track, index) => ({
    label: truncate(track.info?.title || "Unknown title", 100),
    description: truncate(track.info?.author || "Unknown artist", 100),
    value: String(index),
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${SELECT_PREFIX}${cacheKey}`)
      .setPlaceholder("Choose a track to queue")
      .addOptions(options)
  );
}

function buildActionRow(cacheKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${BTN_ADD5_PREFIX}${cacheKey}`).setLabel("Add 5 Related").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${BTN_ADD10_PREFIX}${cacheKey}`).setLabel("Add 10 Related").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${BTN_SHUFFLE_PREFIX}${cacheKey}`).setLabel("Shuffle Queue").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${BTN_CANCEL_PREFIX}${cacheKey}`).setLabel("Cancel").setStyle(ButtonStyle.Danger)
  );
}

function buildNowPlayingEmbed(track, requesterTag) {
  return new EmbedBuilder()
    .setTitle("Now Queued")
    .setDescription(`**${track.info?.title || "Unknown title"}**`)
    .setURL(track.info?.uri || null)
    .addFields(
      { name: "Artist", value: track.info?.author || "Unknown", inline: true },
      { name: "Duration", value: formatDuration(track.info?.duration), inline: true },
      { name: "Requested By", value: requesterTag, inline: true }
    );
}

async function cleanupMessageComponents(message, content) {
  try {
    await message.edit({
      content,
      embeds: message.embeds,
      components: [],
    });
  } catch (e) {
    console.error("cleanup message edit failed:", e?.code || e);
  }
}

async function addRelatedTracks(player, source, selectedTrack, amount, requester) {
  const relatedQuery = `${selectedTrack.info?.author || ""} ${selectedTrack.info?.title || ""}`.trim();
  const res = await player.search({ query: relatedQuery, source }, requester);
  const baseId = selectedTrack.info?.identifier;

  const picked = (res?.tracks || [])
    .filter((track) => track.info?.identifier !== baseId)
    .slice(0, amount);

  for (const track of picked) player.queue.add(track);
  return picked.length;
}

function startButtonsCollector(message, ownerUserId, cacheKey) {
  const buttonCollector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: COMPONENT_TIMEOUT_MS,
  });

  buttonCollector.on("collect", async (buttonInteraction) => {
    if (buttonInteraction.user.id !== ownerUserId) {
      return safeReply(buttonInteraction, "❌ This control belongs to another user.");
    }
    await buttonInteraction.deferUpdate();

    const cached = getSearchCache(cacheKey);
    if (!cached) {
      await cleanupMessageComponents(message, "⌛ This /play session expired.");
      return buttonCollector.stop("expired");
    }

    const isAdd5 = buttonInteraction.customId === `${BTN_ADD5_PREFIX}${cacheKey}`;
    const isAdd10 = buttonInteraction.customId === `${BTN_ADD10_PREFIX}${cacheKey}`;
    const isShuffle = buttonInteraction.customId === `${BTN_SHUFFLE_PREFIX}${cacheKey}`;
    const isCancel = buttonInteraction.customId === `${BTN_CANCEL_PREFIX}${cacheKey}`;

    if (!isAdd5 && !isAdd10 && !isShuffle && !isCancel) return;

    try {
      if (isCancel) {
        deleteSearchCache(cacheKey);
        await cleanupMessageComponents(message, "❌ Cancelled.");
        return buttonCollector.stop("cancelled");
      }

      const { player, error } = await getOrCreatePlayer(buttonInteraction);
      if (error) {
        await cleanupMessageComponents(message, `❌ ${error}`);
        deleteSearchCache(cacheKey);
        return buttonCollector.stop("error");
      }

      if (isShuffle) {
        const shuffled = await player.queue.shuffle();
        await message.edit({
          content: `🔀 Shuffled ${shuffled} queued tracks.`,
          embeds: message.embeds,
          components: message.components,
        });
        return;
      }

      const selectedTrack = cached.selectedTrack;
      if (!selectedTrack) {
        await cleanupMessageComponents(message, "❌ Missing selected track context.");
        deleteSearchCache(cacheKey);
        return buttonCollector.stop("error");
      }

      const amount = isAdd5 ? 5 : 10;
      const added = await addRelatedTracks(
        player,
        cached.source,
        selectedTrack,
        amount,
        buttonInteraction.user
      );
      if (!player.playing) await player.play();

      // Refresh cache TTL while user is actively using controls.
      setSearchCache(cacheKey, cached, SEARCH_CACHE_TTL_MS);
      await message.edit({
        content: `➕ Added ${added} related track(s).`,
        embeds: message.embeds,
        components: message.components,
      });
    } catch (err) {
      console.error("button handler error:", err);
      await cleanupMessageComponents(message, "❌ Failed to handle action.");
      deleteSearchCache(cacheKey);
      buttonCollector.stop("error");
    }
  });

  buttonCollector.on("end", async (_collected, reason) => {
    if (reason === "cancelled" || reason === "error") return;
    await cleanupMessageComponents(message, "⌛ Controls timed out.");
    deleteSearchCache(cacheKey);
  });
}

client.on("interactionCreate", async (interaction) => {
  if (interaction.isStringSelectMenu()) {
    if (!interaction.customId.startsWith(SELECT_PREFIX)) return;
    const cacheKey = interaction.customId.slice(SELECT_PREFIX.length);
    const expectedKey = makeSearchCacheKey(interaction.guildId, interaction.user.id, interaction.message.id);
    if (cacheKey !== expectedKey) {
      return safeReply(interaction, "❌ This menu is not for you.");
    }

    await interaction.deferUpdate();

    const cached = getSearchCache(cacheKey);
    if (!cached) {
      return cleanupMessageComponents(interaction.message, "⌛ This /play session expired.");
    }

    try {
      const pickedIndex = Number(interaction.values?.[0]);
      const selectedTrack = cached.tracks[pickedIndex];
      if (!selectedTrack) {
        deleteSearchCache(cacheKey);
        return cleanupMessageComponents(interaction.message, "❌ Invalid selection.");
      }

      const { player, error } = await getOrCreatePlayer(interaction);
      if (error) {
        deleteSearchCache(cacheKey);
        return cleanupMessageComponents(interaction.message, `❌ ${error}`);
      }

      player.queue.add(selectedTrack);
      if (!player.playing) await player.play();

      setSearchCache(
        cacheKey,
        { ...cached, selectedTrack },
        SEARCH_CACHE_TTL_MS
      );

      await interaction.message.edit({
        content: null,
        embeds: [buildNowPlayingEmbed(selectedTrack, interaction.user.tag)],
        components: [buildActionRow(cacheKey)],
      });

      startButtonsCollector(interaction.message, interaction.user.id, cacheKey);
      return;
    } catch (err) {
      console.error("select handler error:", err);
      deleteSearchCache(cacheKey);
      return cleanupMessageComponents(interaction.message, "❌ Failed to queue selected track.");
    }
  }

  if (interaction.isButton()) return;
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

      const { player, error } = await getOrCreatePlayer(interaction, { connect: false });
      if (error) return safeEdit(interaction, `❌ ${error}`);

      const raw = interaction.options.getString("query", true);
      const { source, query } = pickSource(raw);

      console.log(`🔎 search source=${source} query="${query}"`);
      const res = await player.search({ query, source }, interaction.user);
      const tracks = (res?.tracks || []).slice(0, MAX_MENU_RESULTS);
      if (tracks.length === 0) return safeEdit(interaction, "❌ No results found.");

      const repliedMessage = await interaction.editReply({
        content: "🔎 Found results. Building menu...",
        embeds: [],
        components: [],
      });
      const cacheKey = makeSearchCacheKey(interaction.guildId, interaction.user.id, repliedMessage.id);

      setSearchCache(cacheKey, { tracks, source, query }, SEARCH_CACHE_TTL_MS);

      await interaction.editReply({
        content: "Select a track to add to the queue:",
        embeds: [],
        components: [buildSelectRow(cacheKey, tracks)],
      });

      const selectCollector = repliedMessage.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: COMPONENT_TIMEOUT_MS,
      });

      selectCollector.on("collect", (menuInteraction) => {
        if (menuInteraction.customId === `${SELECT_PREFIX}${cacheKey}` &&
            menuInteraction.user.id === interaction.user.id) {
          // Global interaction handler processes the selection action.
          selectCollector.stop("selected");
        }
      });

      selectCollector.on("end", async (_collected, reason) => {
        if (reason === "selected") return;
        await cleanupMessageComponents(repliedMessage, "⌛ Selection timed out.");
        deleteSearchCache(cacheKey);
      });

      return;
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
