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

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');
if (!fs.existsSync(SLOTS_FILE)) fs.writeFileSync(SLOTS_FILE, '[]');

let users = JSON.parse(fs.readFileSync(USERS_FILE));
let slots = JSON.parse(fs.readFileSync(SLOTS_FILE));

const MAX_SLOTS = 6;

// ===== SAVE =====
const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
const saveSlots = () => fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2));

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open admin panel'),

  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits to a user')
    .addUserOption(o =>
      o.setName('user')
       .setDescription('The user to give credits to')
       .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('amount')
       .setDescription('Amount of credits to give')
       .setRequired(true)
    ),

  new SlashCommandBuilder().setName('pauseall').setDescription('Pause all active slots'),
  new SlashCommandBuilder().setName('unpauseall').setDescription('Unpause all paused slots'),

  new SlashCommandBuilder()
    .setName('releaseslot')
    .setDescription('Release a user’s slot')
    .addUserOption(o =>
      o.setName('user')
       .setDescription('User whose slot to release')
       .setRequired(true)
    ),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

// ===== REGISTER =====
async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Commands registered');
}

// ===== LUARMOR KEY GENERATION (UNCHANGED) =====
async function createLuarmorKey(hours, discordId) {
  const expiryUnix = Math.floor(Date.now() / 1000) + hours * 3600;

  const res = await axios.post(
    `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
    { discord_id: discordId, auth_expire: expiryUnix },
    { headers: { Authorization: process.env.LUARMOR_API_KEY, 'Content-Type': 'application/json' } }
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
  if (!key) throw new Error('No key found');

  return { key, expiry: expiryUnix * 1000 };
}

// ===== TIME =====
const formatTime = ms => {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

// ===== EMBED =====
function generateSlotsEmbed() {
  const embed = new EmbedBuilder().setTitle('🎟️ Global Slots').setColor(0x0099ff);
  const now = Date.now();

  const active = slots
    .filter(s => s)
    .sort((a, b) => (a.paused ? 1 : 0) - (b.paused ? 1 : 0));

  for (let i = 0; i < MAX_SLOTS; i++) {
    const slot = active[i];

    if (slot) {
      const user = client.users.cache.get(slot.userId);
      const time = slot.paused ? slot.remaining : slot.expiry - now;

      embed.addFields({
        name: `Slot ${i + 1}`,
        value: slot.paused
          ? `⏸️ ${user?.tag || 'Unknown'}\nRemaining: ${formatTime(time)}`
          : `🔴 ${user?.tag || 'Unknown'}\nExpires in: ${formatTime(time)}`
      });
    } else {
      embed.addFields({ name: `Slot ${i + 1}`, value: '🟢 Available' });
    }
  }

  return embed;
}

// ===== ADMIN CHECK =====
const isAdmin = id => process.env.ADMIN_IDS.split(',').includes(id);

// ===== COMMAND HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const id = interaction.user.id;

  if (!users[id]) users[id] = { credits: 0, processed: [], btc: null, ltc: null };

  try {
    // ===== PANEL =====
    if (interaction.commandName === 'panel' && isAdmin(id)) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('credits').setLabel('💰 Credits').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('activate').setLabel('⚡ Activate').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('slots').setLabel('📊 Slots').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('crypto').setLabel('💳 Crypto').setStyle(ButtonStyle.Success)
      );

      return interaction.reply({ embeds: [generateSlotsEmbed()], components: [row] });
    }

    // ===== GIVE CREDITS =====
    if (interaction.commandName === 'givecredits' && isAdmin(id)) {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');

      if (!users[target.id]) users[target.id] = { credits: 0, processed: [], btc: null, ltc: null };
      users[target.id].credits += amount;
      saveUsers();

      return interaction.reply(`✅ Gave ${amount} credits to ${target.tag}`);
    }

    // ===== PAUSE ALL =====
    if (interaction.commandName === 'pauseall' && isAdmin(id)) {
      const now = Date.now();
      for (const slot of slots) {
        if (slot && !slot.paused && slot.expiry > now) {
          slot.paused = true;
          slot.pausedAt = now;                 // mark when pause started
          slot.remaining = slot.expiry - now;  // store remaining time

          // Delete Luarmor key
          try {
            await axios.delete(
              `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users/${slot.userId}`,
              { headers: { Authorization: process.env.LUARMOR_API_KEY } }
            );
          } catch {}
        }
      }
      saveSlots();
      return interaction.reply('⏸️ All slots paused (keys deleted)');
    }

    // ===== UNPAUSE ALL =====
    if (interaction.commandName === 'unpauseall' && isAdmin(id)) {
      const now = Date.now();

      for (const slot of slots) {
        if (slot && slot.paused) {
          const hours = Math.ceil(slot.remaining / 3600000); // convert ms to hours
          try {
            const { key, expiry } = await createLuarmorKey(hours, slot.userId);

            slot.key = key;
            slot.expiry = expiry;
            slot.paused = false;
            slot.pausedAt = null;
            slot.remaining = null;

            // DM user their new key
            try {
              const userObj = await client.users.fetch(slot.userId);
              await userObj.send(`🔑 Your new key after pause: ${key}\nExpires in: ${formatTime(expiry - Date.now())}`);
            } catch {}
          } catch (err) {
            console.error(`Failed to unpause slot for ${slot.userId}:`, err.message);
          }
        }
      }

      saveSlots();
      return interaction.reply('▶️ All slots unpaused and new keys generated');
    }

    // ===== RELEASE SLOT =====
    if (interaction.commandName === 'releaseslot' && isAdmin(id)) {
      const u = interaction.options.getUser('user');
      const index = slots.findIndex(s => s.userId === u.id);
      if (index === -1) return interaction.reply('❌ No slot');

      try {
        await axios.delete(
          `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users/${u.id}`,
          { headers: { Authorization: process.env.LUARMOR_API_KEY } }
        );
      } catch {}

      slots.splice(index, 1);
      saveSlots();
      return interaction.reply(`✅ Released ${u.tag}`);
    }
  } catch (err) {
    console.error(err);
    if (!interaction.replied) {
      return interaction.reply({ content: `❌ Error: ${err.message}`, ephemeral: true });
    }
  }
});

// ===== BUTTON HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const id = interaction.user.id;
  if (!users[id]) users[id] = { credits: 0, processed: [], btc: null, ltc: null };

  try {
    if (interaction.customId === 'credits') {
      return interaction.reply({ content: `💰 ${users[id].credits} credits`, ephemeral: true });
    }

    if (interaction.customId === 'activate') {
      if (users[id].credits <= 0)
        return interaction.reply({ content: '❌ You have no credits', ephemeral: true });

      if (slots.filter(s => !s.paused).length >= MAX_SLOTS)
        return interaction.reply({ content: '❌ All slots full', ephemeral: true });

      // Show modal to ask how many credits to spend
      const modal = new ModalBuilder()
        .setCustomId('activate_modal')
        .setTitle('Activate Slot');

      const input = new TextInputBuilder()
        .setCustomId('credits_amount')
        .setLabel(`Credits to spend (1 credit = 1 hour)`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const row = new ActionRowBuilder().addComponents(input);
      modal.addComponents(row);

      return interaction.showModal(modal);
    }

    if (interaction.customId === 'slots') {
      return interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
    }

    if (interaction.customId === 'crypto') {
      const btc = await axios.post(`https://api.blockcypher.com/v1/btc/main/addrs?token=${process.env.BLOCKCYPHER_TOKEN}`);
      const ltc = await axios.post(`https://api.blockcypher.com/v1/ltc/main/addrs?token=${process.env.BLOCKCYPHER_TOKEN}`);

      users[id].btc = btc.data.address;
      users[id].ltc = ltc.data.address;
      users[id].processed = [];
      saveUsers();

      return interaction.reply({
        content: `BTC: ${users[id].btc}\nLTC: ${users[id].ltc}`,
        ephemeral: true
      });
    }
  } catch (err) {
    console.error(err);
    if (!interaction.replied) {
      return interaction.reply({ content: `❌ Error: ${err.message}`, ephemeral: true });
    }
  }
});

// ===== MODAL HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;
  if (interaction.customId !== 'activate_modal') return;

  const id = interaction.user.id;
  if (!users[id]) users[id] = { credits: 0, processed: [], btc: null, ltc: null };

  const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));
  const userData = users[id];

  if (!creditsToSpend || creditsToSpend > userData.credits)
    return interaction.reply({ content: '❌ Invalid or insufficient credits', ephemeral: true });

  if (slots.filter(s => !s.paused).length >= MAX_SLOTS)
    return interaction.reply({ content: '❌ All slots full', ephemeral: true });

  try {
    // 1 credit = 1 hour
    const { key, expiry } = await createLuarmorKey(creditsToSpend, id);

    const existingSlotIndex = slots.findIndex(s => s.userId === id && !s.paused);
    if (existingSlotIndex !== -1) {
      slots[existingSlotIndex] = { userId: id, key, expiry, paused: false, remaining: null };
    } else {
      slots.push({ userId: id, key, expiry, paused: false, remaining: null });
    }

    userData.credits -= creditsToSpend;

    saveUsers();
    saveSlots();

    return interaction.reply({
      content: `✅ Slot activated!\nKey: ${key}\nExpires in: ${formatTime(expiry - Date.now())}`,
      ephemeral: true
    });

  } catch (err) {
    console.error(err);
    return interaction.reply({
      content: `❌ Luarmor Error:\n${err.message}`,
      ephemeral: true
    });
  }
});

// ===== AUTO CLEANUP (EXPIRED KEYS) =====
setInterval(async () => {
  const now = Date.now();
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    if (!s.paused && s.expiry <= now) {
      try {
        await axios.delete(
          `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users/${s.userId}`,
          { headers: { Authorization: process.env.LUARMOR_API_KEY } }
        );
      } catch {}
      slots.splice(i, 1);
    }
  }
  saveSlots();
}, 60000);

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
          if (credits > 0) {
            u.credits += credits;
            u.processed.push(tx.tx_hash);
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
    res.on('end', () => console.log('🌐 Outbound IP:', JSON.parse(data).ip));
  });
});

client.login(process.env.BOT_TOKEN);
