require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  REST, Routes, SlashCommandBuilder
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== CONFIG =====
const MAX_SLOTS = 10;
const CREDITS_PER_DAY = 5;
const ADMIN_IDS = process.env.ADMIN_IDS.split(',');

// ===== FILES =====
const USERS_FILE = './users.json';
const SLOTS_FILE = './slots.json';

let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : {};
let slots = fs.existsSync(SLOTS_FILE) ? JSON.parse(fs.readFileSync(SLOTS_FILE)) : [];

let panelMessage = null;

// ===== SAVE =====
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveSlots() { fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2)); }

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open panel'),
  new SlashCommandBuilder()
    .setName('credits')
    .setDescription('Check credits')
    .addUserOption(o => o.setName('user')),
  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits')
    .addUserOption(o => o.setName('user').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setRequired(true)),
  new SlashCommandBuilder()
    .setName('removecredits')
    .setDescription('Remove credits')
    .addUserOption(o => o.setName('user').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setRequired(true)),
  new SlashCommandBuilder()
    .setName('releaseslot')
    .setDescription('Release slot')
    .addUserOption(o => o.setName('user').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
}

// ===== LUARMOR =====
async function createLuarmorKey(hours, discordId) {
  const expiryUnix = Math.floor(Date.now() / 1000) + hours * 3600;

  const res = await axios({
    method: "POST",
    url: `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
    headers: {
      Authorization: `Bearer ${process.env.LUARMOR_API_KEY}`,
      "Content-Type": "application/json"
    },
    data: { discord_id: discordId, auth_expire: expiryUnix }
  });

  const key = res.data?.user?.key;
  if (!key) throw new Error("No key returned");

  return { key, expiry: expiryUnix * 1000 };
}

// ===== EMBED =====
function generateSlotsEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('🎟️ Global Slots')
    .setColor(0x00bfff)
    .setFooter({ text: 'Auto-updates every 10s' });

  const now = Date.now();
  const active = slots.filter(s => s.expiry > now);

  let desc = "";
  for (let i = 0; i < MAX_SLOTS; i++) {
    const s = active[i];
    if (s) {
      const user = client.users.cache.get(s.userId);
      desc += `**${i + 1}. 🔴 ${user ? user.tag : "Unknown"}**\n<t:${Math.floor(s.expiry/1000)}:R>\n\n`;
    } else {
      desc += `**${i + 1}. 🟢 Available**\n\n`;
    }
  }
  embed.setDescription(desc);
  return embed;
}

// ===== COMMAND HANDLER =====
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  const isAdmin = ADMIN_IDS.includes(i.user.id);

  if (i.commandName === 'panel') {
    const embed = generateSlotsEmbed();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('credits').setLabel('💰 Credits').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('activate').setLabel('⚡ Activate').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('slots').setLabel('📊 Refresh').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('crypto').setLabel('💳 Crypto').setStyle(ButtonStyle.Success)
    );

    const msg = await i.reply({ embeds: [embed], components: [row], fetchReply: true });
    panelMessage = msg;
  }

  if (i.commandName === 'credits') {
    const target = i.options.getUser('user') || i.user;
    if (target.id !== i.user.id && !isAdmin) return i.reply({ content: 'Admin only', ephemeral: true });
    if (!users[target.id]) users[target.id] = { credits: 0, processed: [], btc: null, ltc: null };
    return i.reply({ content: `${target.tag}: ${users[target.id].credits}`, ephemeral: true });
  }

  if (i.commandName === 'givecredits' && isAdmin) {
    const u = i.options.getUser('user');
    const amt = i.options.getInteger('amount');
    if (!users[u.id]) users[u.id] = { credits: 0, processed: [], btc: null, ltc: null };
    users[u.id].credits += amt;
    saveUsers();
    return i.reply(`Gave ${amt} credits to ${u.tag}`);
  }

  if (i.commandName === 'removecredits' && isAdmin) {
    const u = i.options.getUser('user');
    const amt = i.options.getInteger('amount');
    if (!users[u.id]) users[u.id] = { credits: 0, processed: [], btc: null, ltc: null };
    users[u.id].credits = Math.max(0, users[u.id].credits - amt);
    saveUsers();
    return i.reply(`Removed ${amt} credits from ${u.tag}`);
  }

  if (i.commandName === 'releaseslot' && isAdmin) {
    const u = i.options.getUser('user');
    slots = slots.filter(s => s.userId !== u.id);
    saveSlots();
    return i.reply(`Released slot for ${u.tag}`);
  }
});

// ===== BUTTON HANDLER =====
client.on('interactionCreate', async i => {
  if (!i.isButton()) return;
  const id = i.user.id;
  if (!users[id]) users[id] = { credits: 0, processed: [], btc: null, ltc: null };

  if (i.customId === 'credits') return i.reply({ content: `${users[id].credits} credits`, ephemeral: true });
  if (i.customId === 'slots') return i.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });

  if (i.customId === 'activate') {
    const modal = new ModalBuilder().setCustomId('buy').setTitle('Activate Slot');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('credits').setLabel('Credits (5 = 1 day)').setStyle(TextInputStyle.Short).setRequired(true)
      )
    );
    return i.showModal(modal);
  }

  if (i.customId === 'crypto') {
    try {
      const btc = await axios.post('https://api.blockcypher.com/v1/btc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });
      const ltc = await axios.post('https://api.blockcypher.com/v1/ltc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });

      users[id].btc = btc.data.address;
      users[id].ltc = ltc.data.address;
      users[id].processed = [];

      saveUsers();

      return i.reply({ content: `💳 Send crypto to get credits:\nBTC: ${users[id].btc}\nLTC: ${users[id].ltc}`, ephemeral: true });
    } catch (err) {
      return i.reply({ content: `❌ Failed to generate wallets: ${err.message}`, ephemeral: true });
    }
  }
});

// ===== MODAL HANDLER =====
client.on('interactionCreate', async i => {
  if (!i.isModalSubmit() || i.customId !== 'buy') return;
  const credits = parseInt(i.fields.getTextInputValue('credits'));
  const user = users[i.user.id];

  if (!credits || credits > user.credits) return i.reply({ content: '❌ Invalid credits', ephemeral: true });
  if (credits % CREDITS_PER_DAY !== 0) return i.reply({ content: '❌ Must be multiple of 5', ephemeral: true });

  const hours = (credits / CREDITS_PER_DAY) * 24;
  const { key, expiry } = await createLuarmorKey(hours, i.user.id);

  slots.push({ userId: i.user.id, expiry });
  user.credits -= credits;

  saveUsers();
  saveSlots();

  i.reply({ content: `✅ Activated\nKey: ${key}`, ephemeral: true });
});

// ===== AUTO SLOT CLEANUP =====
setInterval(() => { slots = slots.filter(s => s.expiry > Date.now()); saveSlots(); }, 60000);

// ===== AUTO CRYPTO CHECK =====
setInterval(async () => {
  for (const id in users) {
    const u = users[id];
    for (const type of ['btc','ltc']) {
      if (!u[type]) continue;
      try {
        const res = await axios.get(`https://api.blockcypher.com/v1/${type}/main/addrs/${u[type]}`);
        const txs = res.data.txrefs || [];
        for (const tx of txs) {
          if (tx.confirmations < 1 || u.processed.includes(tx.tx_hash)) continue;
          const c = Math.floor(tx.value / 100000);
          if (c > 0) { u.credits += c; u.processed.push(tx.tx_hash); console.log(`💰 ${c} credits to ${id}`); }
        }
      } catch {}
    }
  }
  saveUsers();
}, 20000);

// ===== AUTO PANEL UPDATE =====
setInterval(async () => { if (panelMessage) panelMessage.edit({ embeds: [generateSlotsEmbed()] }).catch(()=>{}); }, 10000);

// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(process.env.BOT_TOKEN);
