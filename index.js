require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  REST, Routes, SlashCommandBuilder
} = require('discord.js');

const axios = require('axios');
const fs = require('fs');
const express = require('express');

// ===== SETUP =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
app.use(express.json());

const USERS_FILE = './users.json';
let users = fs.existsSync(USERS_FILE)
  ? JSON.parse(fs.readFileSync(USERS_FILE))
  : {};

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

const ADMIN_IDS = process.env.ADMIN_IDS.split(',');

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open panel'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
}

// ===== LUARMOR =====
async function createLuarmorKey(discordId, hours) {
  const expiryUnix = Math.floor(Date.now() / 1000) + (hours * 3600);

  await axios.post(
    `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
    { auth_expire: expiryUnix, discord_id: discordId },
    { headers: { Authorization: process.env.LUARMOR_API_KEY } }
  );

  const res = await axios.get(
    `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
    { headers: { Authorization: process.env.LUARMOR_API_KEY } }
  );

  const user = res.data.users.find(u => u.discord_id === discordId);
  return user?.key || "ERROR_KEY";
}

// ===== FORMAT TIME =====
function formatTime(ms) {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return `${hours}h ${remainingMinutes}m`;
}

// ===== PANEL =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'panel') {
    const embed = new EmbedBuilder()
      .setTitle('🔑 Slot System')
      .setDescription('1 Credit = 2 Hours');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('credits').setLabel('💰 Credits').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('buy').setLabel('💳 Buy').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('activate').setLabel('⚡ Activate').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('release').setLabel('❌ Release').setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  }
});

// ===== BUTTONS =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const id = interaction.user.id;
  if (!users[id]) users[id] = { credits: 0, slots: [] };

  if (interaction.customId === 'credits') {
    return interaction.reply({
      content: `💰 Credits: ${users[id].credits}`,
      ephemeral: true
    });
  }

  if (interaction.customId === 'buy') {
    // Generate BTC + LTC address
    const btc = await axios.post(`https://api.blockcypher.com/v1/btc/main/addrs`, {}, {
      params: { token: process.env.BLOCKCYPHER_TOKEN }
    });

    const ltc = await axios.post(`https://api.blockcypher.com/v1/ltc/main/addrs`, {}, {
      params: { token: process.env.BLOCKCYPHER_TOKEN }
    });

    users[id].btc = btc.data.address;
    users[id].ltc = ltc.data.address;
    users[id].processed = [];

    saveUsers();

    return interaction.reply({
      content:
`💳 Send crypto:

🟠 BTC:
\`${btc.data.address}\`

⚪ LTC:
\`${ltc.data.address}\`

Credits are added automatically.`,
      ephemeral: true
    });
  }

  if (interaction.customId === 'activate') {
    if (users[id].credits < 1)
      return interaction.reply({ content: '❌ Not enough credits', ephemeral: true });

    const hours = 2;
    const key = await createLuarmorKey(id, hours);

    users[id].credits -= 1;
    users[id].slots.push({
      key,
      expiry: Date.now() + hours * 3600000
    });

    saveUsers();

    return interaction.reply({
      content: `✅ Key: \`${key}\`\nExpires in ${formatTime(hours * 3600000)}`,
      ephemeral: true
    });
  }

  if (interaction.customId === 'release') {
    if (users[id].slots.length === 0)
      return interaction.reply({ content: 'No slots', ephemeral: true });

    users[id].slots.pop();
    saveUsers();

    return interaction.reply({ content: '❌ Slot released', ephemeral: true });
  }
});

// ===== AUTO PAYMENT CHECK =====
setInterval(async () => {
  for (const id in users) {
    const user = users[id];

    for (const type of ['btc', 'ltc']) {
      if (!user[type]) continue;

      try {
        const res = await axios.get(
          `https://api.blockcypher.com/v1/${type}/main/addrs/${user[type]}`
        );

        const txs = res.data.txrefs || [];

        txs.forEach(tx => {
          if (tx.confirmations < 1) return;

          if (user.processed.includes(tx.tx_hash)) return;

          const credits = Math.floor(tx.value / 100000); // adjust rate
          user.credits += credits;
          user.processed.push(tx.tx_hash);

          console.log(`Added ${credits} credits to ${id}`);
        });

      } catch {}
    }
  }

  saveUsers();
}, 20000);

// ===== BACKEND =====
app.get('/', (req, res) => res.send('Running'));
app.get('/users.json', (req, res) => res.json(users));

app.listen(process.env.PORT || 3000);

// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag}`);
  await registerCommands();
});

client.login(process.env.BOT_TOKEN);
