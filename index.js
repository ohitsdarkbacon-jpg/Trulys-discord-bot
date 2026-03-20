require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const https = require('https');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== DATA FILES =====
const USERS_FILE = './users.json';
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : {};
const MAX_SLOTS = 6;
let slots = []; // { userId, key, expiry }

function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveSlots() { fs.writeFileSync('./slots.json', JSON.stringify(slots, null, 2)); }

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open panel'),
  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits to a user')
    .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Credits amount').setRequired(true))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
  try {
    console.log('⏳ Registering commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Commands registered!');
  } catch (err) { console.error(err); }
}

// ===== LUARMOR KEY =====
async function createLuarmorKey(hours) {
  const expiryUnix = Math.floor(Date.now() / 1000) + hours * 3600;
  try {
    const response = await axios.post(
      `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
      { auth_expire: expiryUnix },
      { headers: { Authorization: process.env.LUARMOR_API_KEY } }
    );

    // Find key in response recursively
    const findKey = obj => {
      if (typeof obj === 'string' && obj.match(/^[A-Za-z0-9]{6,}$/)) return obj;
      if (typeof obj === 'object' && obj) for (const val of Object.values(obj)) { const res = findKey(val); if (res) return res; }
      return null;
    };

    const key = findKey(response.data);
    if (!key) throw new Error(JSON.stringify(response.data));
    return key;
  } catch (err) {
    console.error('Luarmor key error:', err.response?.data || err.message);
    throw new Error(`Failed to generate Luarmor key: ${err.message}`);
  }
}

// ===== TIME FORMAT =====
function formatTime(ms) {
  const totalMins = Math.floor(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const minutes = totalMins % 60;
  return `${hours}h ${minutes}m`;
}

// ===== SLOT EMBED =====
function generateSlotsEmbed() {
  const embed = new EmbedBuilder().setTitle('🎟️ Global Slots').setColor(0x0099ff);
  for (let i = 0; i < MAX_SLOTS; i++) {
    const slot = slots[i];
    if (slot && slot.expiry > Date.now()) {
      const user = client.users.cache.get(slot.userId);
      embed.addFields({ name: `Slot ${i + 1}`, value: `✅ Taken by ${user ? user.tag : 'Unknown'}\nExpires in: ${formatTime(slot.expiry - Date.now())}` });
    } else embed.addFields({ name: `Slot ${i + 1}`, value: '🟢 Available' });
  }
  return embed;
}

// ===== COMMAND HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'panel' && process.env.ADMIN_IDS.split(',').includes(interaction.user.id)) {
    const embed = new EmbedBuilder().setTitle('🔑 Luarmor Slot System').setDescription('1 Credit = 1€ = 2 Hours\nMax 6 slots total').setColor(0x00ff00);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('get_credits').setLabel('🛒 Get Credits').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('activate_slot').setLabel('⚡ Activate Slot').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('view_slots').setLabel('📊 View Slots').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_crypto').setLabel('💳 Buy with Crypto').setStyle(ButtonStyle.Success)
    );
    await interaction.reply({ embeds: [embed, generateSlotsEmbed()], components: [row] });
  }

  if (interaction.commandName === 'givecredits' && process.env.ADMIN_IDS.split(',').includes(interaction.user.id)) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (!users[target.id]) users[target.id] = { credits: 0, processed: [], btc: null, ltc: null };
    users[target.id].credits += amount;
    saveUsers();
    await interaction.reply(`✅ Gave **${amount} credits** to ${target.tag}`);
  }
});

// ===== BUTTON HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const userId = interaction.user.id;
  if (!users[userId]) users[userId] = { credits: 0, processed: [], btc: null, ltc: null };

  if (interaction.customId === 'get_credits') {
    await interaction.reply({ content: `🛒 You have **${users[userId].credits} credits**.`, ephemeral: true });
  }

  if (interaction.customId === 'activate_slot') {
    if (slots.filter(s => s.expiry > Date.now()).length >= MAX_SLOTS) return interaction.reply({ content: '❌ All 6 slots taken!', ephemeral: true });

    const modal = new ModalBuilder().setCustomId('activate_modal').setTitle('Activate Slot');
    const input = new TextInputBuilder().setCustomId('credits_amount').setLabel('Credits to spend').setStyle(TextInputStyle.Short).setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'view_slots') {
    await interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
  }

  // Generate crypto wallets
  if (interaction.customId === 'buy_crypto') {
    try {
      const btcAddr = await axios.post('https://api.blockcypher.com/v1/btc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });
      const ltcAddr = await axios.post('https://api.blockcypher.com/v1/ltc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });
      users[userId].btc = btcAddr.data.address;
      users[userId].ltc = ltcAddr.data.address;
      users[userId].processed = [];
      saveUsers();

      await interaction.reply({
        content: `💳 Send crypto to get credits automatically:\nBTC: ${users[userId].btc}\nLTC: ${users[userId].ltc}\n1€ = 1 credit`,
        ephemeral: true
      });
    } catch (err) {
      return interaction.reply({ content: '❌ Failed to generate crypto wallets. Check API token.', ephemeral: true });
    }
  }
});

// ===== MODAL HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit() || interaction.customId !== 'activate_modal') return;

  const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));
  const userData = users[interaction.user.id];

  if (!creditsToSpend || creditsToSpend > userData.credits) return interaction.reply({ content: '❌ Invalid or insufficient credits', ephemeral: true });
  if (slots.filter(s => s.expiry > Date.now()).length >= MAX_SLOTS) return interaction.reply({ content: '❌ All slots full', ephemeral: true });

  const hours = creditsToSpend * 2;

  try {
    const key = await createLuarmorKey(hours);
    slots.push({ userId: interaction.user.id, key, expiry: Date.now() + hours * 3600000 });
    userData.credits -= creditsToSpend;
    saveUsers();
    saveSlots();

    await interaction.reply({ content: `✅ Slot activated!\nKey: ${key}\nExpires in: ${formatTime(hours * 3600000)}`, ephemeral: true });
  } catch (err) {
    await interaction.reply({ content: `❌ Failed to generate key: ${err.message}`, ephemeral: true });
  }
});

// ===== AUTO CLEANUP =====
setInterval(() => { slots = slots.filter(s => s.expiry > Date.now()); saveSlots(); }, 60000);

// ===== AUTO CRYPTO PAYMENT CHECK =====
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
          const credits = Math.floor(tx.value / 100000); // Satoshis or litoshis to 1 credit per 1e-6 BTC/LTC
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

  https.get('https://api.ipify.org?format=json', res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => { try { console.log('Outbound IP:', JSON.parse(data).ip); } catch {} });
  });
});

client.login(process.env.BOT_TOKEN);
