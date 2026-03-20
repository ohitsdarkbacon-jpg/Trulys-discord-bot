require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  REST, Routes, SlashCommandBuilder
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const express = require('express');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== DATA FILES =====
const USERS_FILE = './users.json';
const SLOTS_FILE = './slots.json';
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : {};
let slots = fs.existsSync(SLOTS_FILE) ? JSON.parse(fs.readFileSync(SLOTS_FILE)) : [];

function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveSlots() { fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2)); }

const ADMIN_IDS = process.env.ADMIN_IDS.split(',');

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open panel'),
  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits to a user')
    .addUserOption(option => option.setName('user').setDescription('Target user').setRequired(true))
    .addIntegerOption(option => option.setName('amount').setDescription('Credits amount').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
}

// ===== OUTBOUND IP LOG =====
function logOutboundIP() {
  https.get('https://api.ipify.org?format=json', res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        const ipData = JSON.parse(data);
        console.log('====================================');
        console.log('CURRENT OUTBOUND IP:', ipData.ip);
        console.log('Check this IP in your Luarmor whitelist');
        console.log('====================================');
      } catch (e) { console.error('Failed to parse outbound IP:', e.message); }
    });
  }).on('error', err => { console.error('Outbound IP check failed:', err.message); });
}

// ===== LUARMOR KEY =====
async function createLuarmorKey(discordId, msUntilExpiry) {
  const expiryUnix = Math.floor(Date.now() / 1000) + Math.floor(msUntilExpiry / 1000);

  try {
    // Step 1: Create new user/key (omit discord_id to force fresh key)
    const createRes = await axios.post(
      `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
      { auth_expire: expiryUnix }, // ← no discord_id here = new unclaimed key
      {
        headers: {
          Authorization: process.env.LUARMOR_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    // Log full response for debug
    console.log('Luarmor POST response:', JSON.stringify(createRes.data, null, 2));

    if (!createRes.data.success) {
      throw new Error(`Luarmor POST failed: ${createRes.data.message || 'Unknown error'}`);
    }

    // Step 2: Immediately GET users and find the newest one (most reliable)
    const listRes = await axios.get(
      `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
      {
        headers: { Authorization: process.env.LUARMOR_API_KEY },
        timeout: 10000
      }
    );

    // Sort by creation time (newest first) or assume last in list
    const usersList = listRes.data.users || [];
    const newestUser = usersList.sort((a, b) => {
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      return tb - ta; // newest first
    })[0];

    const key = newestUser?.key || newestUser?.user_key;
    if (!key) {
      throw new Error('No key found in GET response after create');
    }

    // Optional: associate with discord_id after creation (PATCH)
    // await axios.patch(..., { user_key: key, discord_id: discordId }, ...);

    return key;
  } catch (err) {
    console.error('Luarmor API error:', err.response?.data || err.message);
    throw new Error(`Failed to create key: ${err.message}`);
  }
}
// ===== TIME FORMAT =====
function formatTime(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

// ===== EXPRESS BACKEND =====
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Running'));
app.listen(process.env.PORT || 3000);

// ===== DISCORD PANEL =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'panel') {
    const embed = new EmbedBuilder().setTitle('🔑 Slot System').setDescription('1 Credit = 2 Hours');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('credits').setLabel('💰 Credits').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('buy').setLabel('💳 Buy').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('activate').setLabel('⚡ Activate Slot').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('release').setLabel('❌ Release Slot').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('viewslots').setLabel('📋 View Slots').setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({ embeds: [embed], components: [row] });
  }

  if (interaction.commandName === 'givecredits' && ADMIN_IDS.includes(interaction.user.id)) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (!users[target.id]) users[target.id] = { credits: 0, processed: [] };
    users[target.id].credits += amount;
    saveUsers();
    await interaction.reply(`✅ Gave **${amount} credits** to ${target.tag}`);
  }
});

// ===== BUTTON HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const id = interaction.user.id;
  if (!users[id]) users[id] = { credits: 0, processed: [] };

  if (interaction.customId === 'credits') return interaction.reply({ content: `💰 Credits: ${users[id].credits}`, ephemeral: true });

  if (interaction.customId === 'buy') {
    try {
      const btc = await axios.post('https://api.blockcypher.com/v1/btc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });
      const ltc = await axios.post('https://api.blockcypher.com/v1/ltc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });
      users[id].btc = btc.data.address;
      users[id].ltc = ltc.data.address;
      users[id].processed = [];
      saveUsers();
      return interaction.reply({
        content: `💳 Send crypto:\n\n🟠 BTC: \`${btc.data.address}\`\n⚪ LTC: \`${ltc.data.address}\`\nCredits will be added automatically.`,
        ephemeral: true
      });
    } catch (err) { return interaction.reply({ content: '❌ Failed to generate wallet. Check API token.', ephemeral: true }); }
  }

  // Activate slot with credits modal
  if (interaction.customId === 'activate') {
    if (slots.filter(s => s.expiry > Date.now()).length >= 6)
      return interaction.reply({ content: '❌ All 6 slots are currently occupied!', ephemeral: true });

    const modal = new ModalBuilder().setCustomId('activate_modal').setTitle('Activate Slot');
    const input = new TextInputBuilder()
      .setCustomId('credits_amount')
      .setLabel('Credits to spend (1 credit = 2 hours)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // Release slot
  if (interaction.customId === 'release') {
    const userSlots = slots.filter(s => s.ownerId === id);
    if (!userSlots.length) return interaction.reply({ content: '❌ You do not own any slots', ephemeral: true });
    slots = slots.filter(s => s.ownerId !== id);
    saveSlots();
    return interaction.reply({ content: '❌ Slot released', ephemeral: true });
  }

  // View slots
  if (interaction.customId === 'viewslots') {
    const activeSlots = slots.filter(s => s.expiry > Date.now());
    if (!activeSlots.length) return interaction.reply({ content: 'No slots are currently active.', ephemeral: true });

    let msg = '🔑 Active Slots:\n\n';
    activeSlots.forEach((s, i) => {
      const remaining = formatTime(s.expiry - Date.now());
      msg += `${i + 1}. Owner: <@${s.ownerId}>\n   Expires in: ${remaining}\n`;
    });
    return interaction.reply({ content: msg, ephemeral: true });
  }
});

// ===== MODAL HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;
  if (interaction.customId !== 'activate_modal') return;

  const id = interaction.user.id;
  const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));
  if (!creditsToSpend || creditsToSpend > users[id].credits)
    return interaction.reply({ content: '❌ Invalid or insufficient credits', ephemeral: true });

  const ms = creditsToSpend * 2 * 60 * 60 * 1000; // each credit = 2 hours
  const key = await createLuarmorKey(id, ms);

  users[id].credits -= creditsToSpend;
  slots.push({ key, ownerId: id, expiry: Date.now() + ms });
  saveUsers();
  saveSlots();

  return interaction.reply({ content: `✅ Key: \`${key}\`\nExpires in ${formatTime(ms)}`, ephemeral: true });
});

// ===== AUTO SLOT CLEANUP =====
setInterval(() => {
  slots = slots.filter(s => s.expiry > Date.now());
  saveSlots();
}, 60 * 1000);

// ===== AUTO PAYMENT CHECK =====
setInterval(async () => {
  for (const id in users) {
    const user = users[id];
    for (const type of ['btc', 'ltc']) {
      if (!user[type]) continue;
      try {
        const res = await axios.get(`https://api.blockcypher.com/v1/${type}/main/addrs/${user[type]}`);
        const txs = res.data.txrefs || [];
        txs.forEach(tx => {
          if (tx.confirmations < 1 || user.processed.includes(tx.tx_hash)) return;
          const credits = Math.floor(tx.value / 100000);
          user.credits += credits;
          user.processed.push(tx.tx_hash);
          console.log(`Added ${credits} credits to ${id}`);
        });
      } catch {}
    }
  }
  saveUsers();
}, 20000);

// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  logOutboundIP();
});

client.login(process.env.BOT_TOKEN);
