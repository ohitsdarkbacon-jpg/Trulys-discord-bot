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

// ===== SAVE =====
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveSlots() { fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2)); }

// ===== ADMIN CHECK =====
function isAdmin(id) {
  return process.env.ADMIN_IDS.split(',').includes(id);
}

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open panel'),

  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true)),

  new SlashCommandBuilder()
    .setName('checkcredits')
    .setDescription('Check credits')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),

  new SlashCommandBuilder()
    .setName('removecredits')
    .setDescription('Remove credits')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true)),

  new SlashCommandBuilder()
    .setName('releaseslot')
    .setDescription('Release slot')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),

  new SlashCommandBuilder()
    .setName('forceslot')
    .setDescription('Force activate slot using credits')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(o => o.setName('credits').setDescription('Credits to use').setRequired(true))

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

  const res = await axios.post(
    `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
    {
      discord_id: discordId,
      auth_expire: expiryUnix
    },
    {
      headers: {
        Authorization: process.env.LUARMOR_API_KEY,
        'Content-Type': 'application/json'
      }
    }
  );

  const findKey = obj => {
    if (typeof obj === 'string' && /^[A-Za-z0-9]{6,}$/.test(obj)) return obj;
    if (typeof obj === 'object') {
      for (const v of Object.values(obj)) {
        const k = findKey(v);
        if (k) return k;
      }
    }
    return null;
  };

  const key = findKey(res.data);
  if (!key) throw new Error(JSON.stringify(res.data));

  return { key, expiry: expiryUnix * 1000 };
}

// ===== TIME =====
function formatTime(ms) {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ===== EMBED =====
function generateSlotsEmbed() {
  const embed = new EmbedBuilder().setTitle('🎟️ Slots').setColor(0x0099ff);

  const now = Date.now();
  const active = slots.filter(s => s.expiry > now);

  for (let i = 0; i < MAX_SLOTS; i++) {
    const s = active[i];
    if (s) {
      const user = client.users.cache.get(s.userId);
      embed.addFields({
        name: `Slot ${i + 1}`,
        value: `🔴 ${user ? user.tag : s.userId}\n${formatTime(s.expiry - now)}`
      });
    } else {
      embed.addFields({ name: `Slot ${i + 1}`, value: '🟢 Free' });
    }
  }

  return embed;
}

// ===== COMMAND HANDLER =====
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'panel' && isAdmin(i.user.id)) {
    return i.reply({
      embeds: [generateSlotsEmbed()],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('activate').setLabel('Activate').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('credits').setLabel('Credits').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('crypto').setLabel('Crypto').setStyle(ButtonStyle.Secondary)
        )
      ]
    });
  }

  if (!isAdmin(i.user.id)) return;

  const target = i.options.getUser('user');

  if (!users[target.id]) users[target.id] = { credits: 0, processed: [], btc: null, ltc: null };

  if (i.commandName === 'checkcredits')
    return i.reply({ content: `${target.tag}: ${users[target.id].credits}`, ephemeral: true });

  if (i.commandName === 'givecredits') {
    const amt = i.options.getInteger('amount');
    users[target.id].credits += amt;
    saveUsers();
    return i.reply(`Added ${amt}`);
  }

  if (i.commandName === 'removecredits') {
    const amt = i.options.getInteger('amount');
    users[target.id].credits = Math.max(0, users[target.id].credits - amt);
    saveUsers();
    return i.reply(`Removed ${amt}`);
  }

  if (i.commandName === 'releaseslot') {
    slots = slots.filter(s => s.userId !== target.id);
    saveSlots();
    return i.reply(`Released slot`);
  }

  if (i.commandName === 'forceslot') {
    const credits = i.options.getInteger('credits');
    const hours = credits * 2;

    if (users[target.id].credits < credits)
      return i.reply('Not enough credits');

    const { key, expiry } = await createLuarmorKey(hours, target.id);

    slots.push({ userId: target.id, key, expiry });
    users[target.id].credits -= credits;

    saveUsers();
    saveSlots();

    return i.reply(`Forced slot for ${target.tag}`);
  }
});

// ===== BUTTONS =====
client.on('interactionCreate', async i => {
  if (!i.isButton()) return;

  const userId = i.user.id;
  if (!users[userId]) users[userId] = { credits: 0, processed: [], btc: null, ltc: null };

  if (i.customId === 'credits')
    return i.reply({ content: `💰 ${users[userId].credits}`, ephemeral: true });

  if (i.customId === 'activate') {
    const modal = new ModalBuilder().setCustomId('m').setTitle('Activate');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('c')
          .setLabel('Credits')
          .setStyle(TextInputStyle.Short)
      )
    );

    return i.showModal(modal);
  }

  if (i.customId === 'crypto') {
    const btc = await axios.post(`https://api.blockcypher.com/v1/btc/main/addrs?token=${process.env.BLOCKCYPHER_TOKEN}`);
    const ltc = await axios.post(`https://api.blockcypher.com/v1/ltc/main/addrs?token=${process.env.BLOCKCYPHER_TOKEN}`);

    users[userId].btc = btc.data.address;
    users[userId].ltc = ltc.data.address;
    users[userId].processed = [];

    saveUsers();

    return i.reply({
      content: `BTC: ${users[userId].btc}\nLTC: ${users[userId].ltc}`,
      ephemeral: true
    });
  }
});

// ===== MODAL =====
client.on('interactionCreate', async i => {
  if (!i.isModalSubmit()) return;

  const credits = parseInt(i.fields.getTextInputValue('c'));
  const user = users[i.user.id];

  if (credits > user.credits) return i.reply({ content: 'No credits', ephemeral: true });

  const hours = credits * 2;

  const { key, expiry } = await createLuarmorKey(hours, i.user.id);

  slots.push({ userId: i.user.id, key, expiry });
  user.credits -= credits;

  saveUsers();
  saveSlots();

  return i.reply({ content: `Key: ${key}`, ephemeral: true });
});

// ===== CRYPTO CHECK =====
setInterval(async () => {
  for (const id in users) {
    const u = users[id];

    for (const type of ['btc', 'ltc']) {
      if (!u[type]) continue;

      try {
        const res = await axios.get(`https://api.blockcypher.com/v1/${type}/main/addrs/${u[type]}`);
        const txs = res.data.txrefs || [];

        for (const tx of txs) {
          if (tx.confirmations < 1 || u.processed.includes(tx.tx_hash)) continue;

          const credits = Math.floor(tx.value / 100000);
          u.credits += credits;
          u.processed.push(tx.tx_hash);
        }
      } catch {}
    }
  }

  saveUsers();
}, 20000);

// ===== READY =====
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  https.get('https://api.ipify.org?format=json', r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => console.log('IP:', JSON.parse(d).ip));
  });
});

client.login(process.env.BOT_TOKEN);
