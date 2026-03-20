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

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers
] });

// ===== Data Files =====
const USERS_FILE = './users.json';
const SLOTS_FILE = './slots.json';
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : {};
let slots = fs.existsSync(SLOTS_FILE) ? JSON.parse(fs.readFileSync(SLOTS_FILE)) : [];
const MAX_SLOTS = 6;

// ===== Utils =====
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveSlots() { fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2)); }
function formatTime(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

// ===== Commands =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open admin panel'),
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

// ===== Outbound IP (for Luarmor whitelist) =====
function logOutboundIP() {
  https.get('https://api.ipify.org?format=json', res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try { console.log('CURRENT OUTBOUND IP:', JSON.parse(data).ip); } 
      catch (e) { console.error('Failed to parse IP:', e.message); }
    });
  }).on('error', e => console.error('Outbound IP check failed:', e.message));
}

// ===== Luarmor Key Generation =====
async function createLuarmorKey(hours) {
  const expiryUnix = Math.floor(Date.now() / 1000) + hours * 3600;
  try {
    const res = await axios.post(
      `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
      { auth_expire: expiryUnix },
      { headers: { Authorization: process.env.LUARMOR_API_KEY, 'Content-Type': 'application/json' } }
    );
    const key = res.data.user?.key;
    if (!key) return { error: true, response: res.data };
    return { key };
  } catch (err) { return { error: true, response: err.response?.data || err.message }; }
}

// ===== Slots Embed =====
function generateSlotsEmbed() {
  const embed = new EmbedBuilder().setTitle('🎟️ Global Slots').setColor(0x0099ff);
  for (let i = 0; i < MAX_SLOTS; i++) {
    const slot = slots[i];
    if (slot && slot.expiry > Date.now()) {
      embed.addFields({ name: `Slot ${i + 1}`, value: `✅ Taken by <@${slot.userId}>\nExpires in: ${formatTime(slot.expiry - Date.now())}` });
    } else embed.addFields({ name: `Slot ${i + 1}`, value: '🟢 Available' });
  }
  return embed;
}

// ===== Command Handler =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const adminIds = process.env.ADMIN_IDS.split(',');

  if (interaction.commandName === 'panel' && adminIds.includes(interaction.user.id)) {
    const embed = new EmbedBuilder().setTitle('🔑 Slot System').setDescription('1 Credit = 2 Hours\nMax 6 slots total').setColor(0x00ff00);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('get_credits').setLabel('🛒 Credits').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('activate_slot').setLabel('⚡ Activate Slot').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('view_slots').setLabel('📊 View Slots').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy').setLabel('💳 Buy Credits').setStyle(ButtonStyle.Success)
    );
    await interaction.reply({ embeds: [embed], components: [row] });
  }

  if (interaction.commandName === 'givecredits' && adminIds.includes(interaction.user.id)) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (!users[target.id]) users[target.id] = { credits: 0, processed: [] };
    users[target.id].credits += amount;
    saveUsers();
    await interaction.reply(`✅ Gave **${amount} credits** to ${target.tag}`);
  }
});

// ===== Button Handler =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const id = interaction.user.id;
  if (!users[id]) users[id] = { credits: 0, processed: [] };

  if (interaction.customId === 'get_credits') {
    return interaction.reply({ content: `💰 Credits: ${users[id].credits}`, ephemeral: true });
  }

  if (interaction.customId === 'buy') {
    try {
      const btcRes = await axios.post(`https://api.blockcypher.com/v1/btc/main/addrs?token=${process.env.BLOCKCYPHER_TOKEN}`, {});
      const ltcRes = await axios.post(`https://api.blockcypher.com/v1/ltc/main/addrs?token=${process.env.BLOCKCYPHER_TOKEN}`, {});
      users[id].btc = btcRes.data.address;
      users[id].ltc = ltcRes.data.address;
      users[id].processed = [];
      saveUsers();
      return interaction.reply({ content: `💳 Send crypto to:\nBTC: ${btcRes.data.address}\nLTC: ${ltcRes.data.address}\nCredits will be added automatically.`, ephemeral: true });
    } catch { return interaction.reply({ content: '❌ Failed to generate wallets', ephemeral: true }); }
  }

  if (interaction.customId === 'activate_slot') {
    if (slots.filter(s => s.expiry > Date.now()).length >= MAX_SLOTS) return interaction.reply({ content: '❌ All slots taken!', ephemeral: true });
    const modal = new ModalBuilder().setCustomId('activate_modal').setTitle('Activate Slot');
    const input = new TextInputBuilder().setCustomId('credits_amount').setLabel('Credits to spend (1 credit = 2 hours)').setStyle(TextInputStyle.Short).setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'view_slots') return interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
});

// ===== Modal Handler =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit() || interaction.customId !== 'activate_modal') return;
  const id = interaction.user.id;
  const credits = parseInt(interaction.fields.getTextInputValue('credits_amount'));
  if (!credits || credits > users[id].credits) return interaction.reply({ content: '❌ Invalid/insufficient credits', ephemeral: true });

  const hours = credits * 2;
  const result = await createLuarmorKey(hours);
  if (result.error) return interaction.reply({ content: `❌ Key generation failed:\n\`\`\`json\n${JSON.stringify(result.response,null,2)}\n\`\`\``, ephemeral: true });

  slots.push({ userId: id, key: result.key, expiry: Date.now() + hours * 3600000 });
  users[id].credits -= credits;
  saveUsers();
  saveSlots();

  return interaction.reply({ content: `✅ Slot activated!\nKey: \`${result.key}\`\nExpires in: ${formatTime(hours * 3600000)}`, ephemeral: true });
});

// ===== Auto Cleanup =====
setInterval(() => {
  slots = slots.filter(s => s.expiry > Date.now());
  saveSlots();
}, 60000);

// ===== Auto Credit Checker (BTC/LTC) =====
setInterval(async () => {
  for (const id in users) {
    const user = users[id];
    for (const coin of ['btc','ltc']) {
      if (!user[coin]) continue;
      try {
        const res = await axios.get(`https://api.blockcypher.com/v1/${coin}/main/addrs/${user[coin]}`);
        const txs = res.data.txrefs || [];
        for (const tx of txs) {
          if (tx.confirmations < 1 || user.processed.includes(tx.tx_hash)) continue;
          const creditsToAdd = Math.floor(tx.value / 100000); // convert satoshis to credits
          user.credits += creditsToAdd;
          user.processed.push(tx.tx_hash);
          console.log(`Added ${creditsToAdd} credits to ${id} (${coin})`);
        }
      } catch {}
    }
  }
  saveUsers();
}, 20000);

// ===== Ready =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  logOutboundIP();
});

client.login(process.env.BOT_TOKEN);
