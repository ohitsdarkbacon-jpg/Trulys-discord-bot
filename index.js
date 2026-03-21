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

const MAX_SLOTS = 6;

function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveSlots() { fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2)); }

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open panel'),
  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits')
    .addUserOption(opt => opt.setName('user').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Commands registered');
}

// ===== LUARMOR FIX =====
async function createLuarmorKey(hours) {
  const expiryUnix = Math.floor(Date.now() / 1000) + (hours * 3600);

  try {
    const res = await axios.post(
      `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/keys`,
      { expires_at: expiryUnix },
      {
        headers: {
          Authorization: process.env.LUARMOR_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const key = res.data?.key || res.data?.data?.key;
    if (!key) throw new Error(JSON.stringify(res.data));

    return key;

  } catch (err) {
    console.error(err.response?.data || err.message);
    throw new Error('Key generation failed');
  }
}

// ===== TIME =====
function formatTime(ms) {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ===== EMBED =====
function generateSlotsEmbed() {
  const embed = new EmbedBuilder().setTitle('🎟️ Slots').setColor(0x0099ff);

  for (let i = 0; i < MAX_SLOTS; i++) {
    const s = slots[i];

    if (s && s.expiry > Date.now()) {
      const user = client.users.cache.get(s.userId);
      embed.addFields({
        name: `Slot ${i + 1}`,
        value: `🔴 ${user ? user.tag : 'Unknown'}\n${formatTime(s.expiry - Date.now())}`
      });
    } else {
      embed.addFields({ name: `Slot ${i + 1}`, value: '🟢 Available' });
    }
  }

  return embed;
}

// ===== COMMANDS =====
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'panel' && process.env.ADMIN_IDS.split(',').includes(i.user.id)) {
    const embed = new EmbedBuilder()
      .setTitle('🔑 Slot System')
      .setDescription('1 Credit = 2 Hours')
      .setColor(0x00ff00);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('get_credits').setLabel('Credits').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('activate_slot').setLabel('Activate').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('view_slots').setLabel('Slots').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_crypto').setLabel('Crypto').setStyle(ButtonStyle.Success)
    );

    await i.reply({ embeds: [embed, generateSlotsEmbed()], components: [row] });
  }

  if (i.commandName === 'givecredits') {
    const u = i.options.getUser('user');
    const amt = i.options.getInteger('amount');

    if (!users[u.id]) users[u.id] = { credits: 0, processed: [] };

    users[u.id].credits += amt;
    saveUsers();

    await i.reply(`✅ ${amt} credits given`);
  }
});

// ===== BUTTONS =====
client.on('interactionCreate', async i => {
  if (!i.isButton()) return;

  const id = i.user.id;
  if (!users[id]) users[id] = { credits: 0, processed: [] };

  if (i.customId === 'get_credits') {
    return i.reply({ content: `💰 ${users[id].credits} credits`, ephemeral: true });
  }

  if (i.customId === 'activate_slot') {
    if (slots.filter(s => s && s.expiry > Date.now()).length >= MAX_SLOTS)
      return i.reply({ content: '❌ Full', ephemeral: true });

    const modal = new ModalBuilder()
      .setCustomId('activate_modal')
      .setTitle('Activate');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('credits_amount')
          .setLabel('Credits')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );

    return i.showModal(modal);
  }

  if (i.customId === 'view_slots') {
    return i.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
  }

  if (i.customId === 'buy_crypto') {
    try {
      const btc = await axios.post('https://api.blockcypher.com/v1/btc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });
      const ltc = await axios.post('https://api.blockcypher.com/v1/ltc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });

      users[id].btc = btc.data.address;
      users[id].ltc = ltc.data.address;
      users[id].processed = [];

      saveUsers();

      await i.reply({
        content: `BTC: ${users[id].btc}\nLTC: ${users[id].ltc}`,
        ephemeral: true
      });

    } catch {
      i.reply({ content: '❌ Wallet error', ephemeral: true });
    }
  }
});

// ===== MODAL =====
client.on('interactionCreate', async i => {
  if (!i.isModalSubmit()) return;
  if (i.customId !== 'activate_modal') return;

  const credits = parseInt(i.fields.getTextInputValue('credits_amount'));
  const user = users[i.user.id];

  if (!credits || credits > user.credits)
    return i.reply({ content: '❌ Invalid', ephemeral: true });

  const hours = credits * 2;

  try {
    const key = await createLuarmorKey(hours);

    const index = slots.findIndex(s => !s || s.expiry <= Date.now());
    if (index === -1)
      return i.reply({ content: '❌ No slot', ephemeral: true });

    slots[index] = {
      userId: i.user.id,
      key,
      expiry: Date.now() + hours * 3600000
    };

    user.credits -= credits;

    saveUsers();
    saveSlots();

    i.reply({
      content: `✅ Key: ${key}\nExpires in ${hours}h`,
      ephemeral: true
    });

  } catch (err) {
    i.reply({ content: '❌ Key failed', ephemeral: true });
  }
});

// ===== CLEANUP =====
setInterval(() => {
  slots = slots.filter(s => s.expiry > Date.now());
  saveSlots();
}, 60000);

// ===== CRYPTO CHECK =====
setInterval(async () => {
  for (const id in users) {
    const user = users[id];

    for (const type of ['btc', 'ltc']) {
      if (!user[type]) continue;

      try {
        const res = await axios.get(`https://api.blockcypher.com/v1/${type}/main/addrs/${user[type]}`);
        const txs = res.data.txrefs || [];

        for (const tx of txs) {
          if (tx.confirmations < 1) continue;
          if (user.processed.includes(tx.tx_hash)) continue;

          const amount = tx.value / 1e8;

          const price = type === 'btc' ? 60000 : 70;
          const credits = Math.floor(amount * price);

          if (credits > 0) {
            user.credits += credits;
            user.processed.push(tx.tx_hash);
            console.log(`💰 ${credits} credits added to ${id}`);
          }
        }

      } catch {}
    }
  }

  saveUsers();

}, 20000);

// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag}`);
  await registerCommands();

  https.get('https://api.ipify.org?format=json', res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try { console.log('IP:', JSON.parse(d).ip); } catch {}
    });
  });
});

client.login(process.env.BOT_TOKEN);
