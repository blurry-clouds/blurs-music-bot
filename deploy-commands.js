require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder().setName("join").setDescription("Join your voice channel"),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song (search text or URL)")
    .addStringOption(o => o.setName("query").setDescription("Song name or URL").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("Skip current track"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop and leave voice"),
].map(c => c.toJSON());

(async () => {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log("✅ Guild slash commands deployed.");
})().catch(err => {
  console.error("❌ Deploy failed:", err);
  process.exit(1);
});
