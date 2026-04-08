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

// ===== FILES =====
const USERS_FILE = './users.json';
const SLOTS_FILE = './slots.json';

let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : {};
let slots = fs.existsSync(SLOTS_FILE) ? JSON.parse(fs.readFileSync(SLOTS_FILE)) : [];

const MAX_SLOTS = 10;
const CREDITS_PER_DAY = 5;

function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveSlots() { fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2)); }

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Open slot panel'),

  new SlashCommandBuilder()
    .setName('checkcredits')
    .setDescription('Check credits of a user')
    .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true)),

  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits to a user')
    .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Credits to give').setRequired(true)),

  new SlashCommandBuilder()
    .setName('removecredits')
    .setDescription('Remove credits from a user')
    .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Credits to remove').setRequired(true)),

  new SlashCommandBuilder()
    .setName('releaseslot')
    .setDescription('Release a user\'s slot')
    .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Commands registered');
}

// ===== LUARMOR KEY GENERATOR =====
async function createLuarmorKey(days, discordId) {
  const expiryUnix = Math.floor(Date.now() / 1000) + days * 24 * 3600;

  try {
    const res = await axios.post(
      `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
      {
        discord_id: discordId,
        auth_expire: expiryUnix
      },
      {
        headers: {
          Authorization: process.env.LUARMOR_API_KEY, // no Bearer
          'Content-Type': 'application/json'
        }
      }
    );

    const findKey = obj => {
      if (typeof obj === 'string' && /^[A-Za-z0-9]{6,}$/.test(obj)) return obj;
      if (typeof obj === 'object' && obj) {
        for (const val of Object.values(obj)) {
          const k = findKey(val);
          if (k) return k;
        }
      }
      return null;
    };

    const key = findKey(res.data);
    if (!key) throw new Error(`No key found: ${JSON.stringify(res.data)}`);
    return { key, expiry: expiryUnix * 1000 };
  } catch (err) {
    const errorData = err.response?.data || err.message;
    throw new Error(typeof errorData === 'string' ? errorData : JSON.stringify(errorData, null, 2));
  }
}

// ===== TIME FORMAT =====
function formatTime(ms) {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ===== SLOTS EMBED =====
function generateSlotsEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('🎟️ Global Slots')
    .setColor(0x0099ff)
    .setDescription('Each day costs 5 credits. Max 10 slots.');

  const now = Date.now();
  const activeSlots = slots.filter(s => s && s.expiry > now).sort((a, b) => a.expiry - b.expiry);

  for (let i = 0; i < MAX_SLOTS; i++) {
    const slot = activeSlots[i];
    if (slot) {
      const user = client.users.cache.get(slot.userId);
      embed.addFields({
        name: `Slot ${i + 1}`,
        value: `🔴 ${user ? user.tag : 'Unknown'}\nExpires in: ${formatTime(slot.expiry - now)}`
      });
    } else {
      embed.addFields({ name: `Slot ${i + 1}`, value: '🟢 Available' });
    }
  }
  return embed;
}

// ===== COMMAND HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const adminIds = process.env.ADMIN_IDS.split(',');

  if (interaction.commandName === 'panel' && adminIds.includes(interaction.user.id)) {
    const embed = new EmbedBuilder()
      .setTitle('🔑 Slot Panel')
      .setColor(0x00ff00);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('activate_slot').setLabel('⚡ Activate Slot').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('view_slots').setLabel('📊 View Slots').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_crypto').setLabel('💳 Buy Credits').setStyle(ButtonStyle.Primary)
    );

    return interaction.reply({ embeds: [embed, generateSlotsEmbed()], components: [row] });
  }

  if (interaction.commandName === 'checkcredits' && adminIds.includes(interaction.user.id)) {
    const target = interaction.options.getUser('user');
    if (!users[target.id]) users[target.id] = { credits: 0, processed: [], btc: null, ltc: null };
    return interaction.reply({ content: `💰 ${target.tag} has ${users[target.id].credits} credits.`, ephemeral: true });
  }

  if (interaction.commandName === 'givecredits' && adminIds.includes(interaction.user.id)) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (!users[target.id]) users[target.id] = { credits: 0, processed: [], btc: null, ltc: null };
    users[target.id].credits += amount;
    saveUsers();
    return interaction.reply({ content: `✅ Gave ${amount} credits to ${target.tag}`, ephemeral: true });
  }

  if (interaction.commandName === 'removecredits' && adminIds.includes(interaction.user.id)) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (!users[target.id]) users[target.id] = { credits: 0, processed: [], btc: null, ltc: null };
    users[target.id].credits = Math.max(0, users[target.id].credits - amount);
    saveUsers();
    return interaction.reply({ content: `✅ Removed ${amount} credits from ${target.tag}`, ephemeral: true });
  }

  if (interaction.commandName === 'releaseslot' && adminIds.includes(interaction.user.id)) {
    const target = interaction.options.getUser('user');
    slots = slots.filter(s => s.userId !== target.id);
    saveSlots();
    return interaction.reply({ content: `✅ Released ${target.tag}'s slot`, ephemeral: true });
  }
});

// ===== BUTTON HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const userId = interaction.user.id;
  if (!users[userId]) users[userId] = { credits: 0, processed: [], btc: null, ltc: null };

  if (interaction.customId === 'view_slots') {
    return interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
  }

  if (interaction.customId === 'buy_crypto') {
    try {
      const btcAddr = await axios.post(`https://api.blockcypher.com/v1/btc/main/addrs?token=${process.env.BLOCKCYPHER_TOKEN}`);
      const ltcAddr = await axios.post(`https://api.blockcypher.com/v1/ltc/main/addrs?token=${process.env.BLOCKCYPHER_TOKEN}`);
      users[userId].btc = btcAddr.data.address;
      users[userId].ltc = ltcAddr.data.address;
      users[userId].processed = [];
      saveUsers();

      return interaction.reply({
        content: `💳 Send crypto to get credits automatically:\nBTC: ${users[userId].btc}\nLTC: ${users[userId].ltc}`,
        ephemeral: true
      });
    } catch (err) {
      return interaction.reply({ content: `❌ Failed to generate wallets\n${err.message}`, ephemeral: true });
    }
  }

  if (interaction.customId === 'activate_slot') {
    if (slots.filter(s => s && s.expiry > Date.now()).length >= MAX_SLOTS)
      return interaction.reply({ content: '❌ All slots are full!', ephemeral: true });

    const modal = new ModalBuilder().setCustomId('activate_modal').setTitle('Activate Slot');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('credits_amount').setLabel('Days to buy (5 credits/day)').setStyle(TextInputStyle.Short).setRequired(true)
      )
    );
    return interaction.showModal(modal);
  }
});

// ===== MODAL HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit() || interaction.customId !== 'activate_modal') return;
  const daysToBuy = parseInt(interaction.fields.getTextInputValue('credits_amount'));
  const userData = users[interaction.user.id];

  const requiredCredits = daysToBuy * CREDITS_PER_DAY;
  if (!daysToBuy || requiredCredits > userData.credits)
    return interaction.reply({ content: `❌ Invalid number of days or insufficient credits (1 day = ${CREDITS_PER_DAY} credits)`, ephemeral: true });

  if (slots.filter(s => s && s.expiry > Date.now()).length >= MAX_SLOTS)
    return interaction.reply({ content: '❌ All slots full', ephemeral: true });

  try {
    const { key, expiry } = await createLuarmorKey(daysToBuy, interaction.user.id);
    const existingSlotIndex = slots.findIndex(s => s.userId === interaction.user.id && s.expiry > Date.now());
    if (existingSlotIndex !== -1) slots[existingSlotIndex] = { userId: interaction.user.id, key, expiry };
    else slots.push({ userId: interaction.user.id, key, expiry });

    userData.credits -= requiredCredits;
    saveUsers();
    saveSlots();

    return interaction.reply({ content: `✅ Slot activated for ${daysToBuy} day(s)!\nKey: ${key}\nExpires in: ${formatTime(expiry - Date.now())}`, ephemeral: true });
  } catch (err) {
    return interaction.reply({ content: `❌ Luarmor Error: ${err.message}`, ephemeral: true });
  }
});

// ===== AUTO CLEANUP =====
setInterval(() => {
  slots = slots.filter(s => s && s.expiry > Date.now());
  saveSlots();
}, 60000);

// ===== AUTO CRYPTO PAYMENT CHECK =====
setInterval(async () => {
  for (const id in users) {
    const user = users[id];
    for (const type of ['btc', 'ltc']) {
      if (!user[type]) continue;
      try {
        const res = await axios.get(`https://api.blockcypher.com/v1/${type}/main/addrs/${user[type]}`);
        const txs = res.data.txrefs || [];
        for (const tx of txs) {
          if (tx.confirmations < 1 || user.processed.includes(tx.tx_hash)) continue;
          const credits = Math.floor(tx.value / 100000);
          if (credits > 0) {
            user.credits += credits;
            user.processed.push(tx.tx_hash);
            console.log(`💰 Added ${credits} credits to ${id}`);
          }
        }
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
    res.on('end', () => { try { console.log('🌐 Outbound IP:', JSON.parse(data).ip); } catch {} });
  });
});

client.login(process.env.BOT_TOKEN);
