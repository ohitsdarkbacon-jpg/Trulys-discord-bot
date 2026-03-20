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

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

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
    .addIntegerOption(option => option.setName('amount').setDescription('Credits amount').setRequired(true)),
  new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Get your personal crypto deposit address')
    .addStringOption(option =>
      option.setName('currency')
        .setDescription('Choose crypto')
        .setRequired(true)
        .addChoices(
          { name: 'Bitcoin (BTC)', value: 'btc' },
          { name: 'Litecoin (LTC)', value: 'ltc' }
        ))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
  try {
    console.log('⏳ Registering commands...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('✅ Commands registered!');
  } catch (err) {
    console.error('Command registration failed:', err);
  }
}

// ===== OUTBOUND IP LOG =====
function logOutboundIP() {
  https.get('https://api.ipify.org?format=json', res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const ip = JSON.parse(data).ip;
        console.log('====================================');
        console.log('CURRENT OUTBOUND IP:', ip);
        console.log('Whitelist this IP in Luarmor');
        console.log('====================================');
      } catch (e) { console.error('Failed to parse outbound IP:', e.message); }
    });
  }).on('error', err => console.error('Outbound IP check failed:', err.message));
}

// ===== LUARMOR KEY =====
async function createLuarmorKey(discordId, msUntilExpiry) {
  const expiryUnix = Math.floor(Date.now() / 1000) + Math.floor(msUntilExpiry / 1000);
  try {
    const createRes = await axios.post(
      `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
      { auth_expire: expiryUnix },
      {
        headers: {
          Authorization: process.env.LUARMOR_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    console.log('Luarmor POST response:', JSON.stringify(createRes.data, null, 2));

    if (!createRes.data.success) {
      throw new Error(`Luarmor POST failed: ${createRes.data.message || 'Unknown'}`);
    }

    const listRes = await axios.get(
      `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
      { headers: { Authorization: process.env.LUARMOR_API_KEY }, timeout: 10000 }
    );

    const usersList = listRes.data.users || [];
    const newest = usersList.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];

    const key = newest?.key || newest?.user_key;
    if (!key) throw new Error('No key found after create');

    return key;
  } catch (err) {
    console.error('Luarmor API error:', err.message, err.response?.data);
    throw err;
  }
}

// ===== TIME FORMAT =====
function formatTime(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

// ===== EXPRESS =====
const app = express();
app.get('/', (req, res) => res.send('Bot running'));
app.listen(process.env.PORT || 3000);

// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  logOutboundIP();
});

// ===== INTERACTIONS =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

  // Defer if needed
  if (interaction.isModalSubmit() || (interaction.isButton() && ['activate', 'release'].includes(interaction.customId))) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  try {
    // SLASH COMMANDS
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel') {
        const embed = new EmbedBuilder()
          .setTitle('🔑 Slot System')
          .setDescription('1 Credit = 2 Hours\nMax 6 slots total')
          .setColor(0x00ff00);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('credits').setLabel('💰 Credits').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('buy').setLabel('💳 Buy').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('activate').setLabel('⚡ Activate Slot').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('release').setLabel('❌ Release Slot').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('viewslots').setLabel('📋 View Slots').setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
      }

      if (interaction.commandName === 'givecredits' && ADMIN_IDS.includes(interaction.user.id)) {
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        if (!users[target.id]) users[target.id] = { credits: 0, btc: null, ltc: null, processed: [] };
        users[target.id].credits += amount;
        saveUsers();
        await interaction.editReply(`✅ Gave **${amount} credits** to ${target.tag}`);
      }

      if (interaction.commandName === 'deposit') {
        const currency = interaction.options.getString('currency');
        const id = interaction.user.id;
        if (!users[id]) users[id] = { credits: 0, btc: null, ltc: null, processed: [] };

        let address = users[id][currency];
        if (!address) {
          try {
            const res = await axios.post(
              `https://api.blockcypher.com/v1/${currency}/main/addrs`,
              {},
              { params: { token: process.env.BLOCKCYPHER_TOKEN } }
            );
            address = res.data.address;
            users[id][currency] = address;
            saveUsers();
          } catch (err) {
            console.error(`Failed to generate ${currency} address for ${id}:`, err.message);
            return interaction.editReply({ content: `❌ Failed to generate ${currency} address. Try again later.` });
          }
        }

        const embed = new EmbedBuilder()
          .setTitle(`Deposit ${currency.toUpperCase()}`)
          .setDescription(`Send any amount to:\n**${address}**\n\nCredits will be added automatically after confirmation (may take a few minutes).`)
          .setColor(0x00ff88)
          .setFooter({ text: `Your current credits: ${users[id].credits || 0}` });

        await interaction.editReply({ embeds: [embed] });
      }
    }

    // BUTTONS
    if (interaction.isButton()) {
      const id = interaction.user.id;
      if (!users[id]) users[id] = { credits: 0, btc: null, ltc: null, processed: [] };

      if (interaction.customId === 'credits') {
        await interaction.editReply({ content: `💰 Credits: ${users[id].credits}` });
      }

      if (interaction.customId === 'buy') {
        await interaction.editReply({
          content: 'Use **/deposit <currency>** to get your personal deposit address.\nSupported: BTC, LTC\nCredits added automatically after payment.'
        });
      }

      if (interaction.customId === 'activate') {
        if (slots.filter(s => s.expiry > Date.now()).length >= 6) {
          return interaction.editReply({ content: '❌ All 6 slots are currently occupied!' });
        }

        const modal = new ModalBuilder()
          .setCustomId('activate_modal')
          .setTitle('Activate Slot');

        const input = new TextInputBuilder()
          .setCustomId('credits_amount')
          .setLabel('Credits to spend (1 = 2 hours)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
      }

      if (interaction.customId === 'release') {
        const userSlots = slots.filter(s => s.ownerId === id);
        if (!userSlots.length) return interaction.editReply({ content: '❌ You do not own any slots' });
        slots = slots.filter(s => s.ownerId !== id);
        saveSlots();
        await interaction.editReply({ content: '❌ Your slot(s) released' });
      }

      if (interaction.customId === 'viewslots') {
        const active = slots.filter(s => s.expiry > Date.now());
        if (!active.length) return interaction.editReply({ content: 'No active slots right now.' });

        const embed = new EmbedBuilder()
          .setTitle('📋 Active Slots')
          .setColor(0x0099ff);

        active.forEach((s, i) => {
          const remaining = formatTime(s.expiry - Date.now());
          const owner = client.users.cache.get(s.ownerId)?.tag || 'Unknown';
          embed.addFields({
            name: `Slot ${i + 1}`,
            value: `Owner: ${owner}\nExpires in: ${remaining}`,
            inline: true
          });
        });

        await interaction.editReply({ embeds: [embed] });
      }
    }

    // MODAL SUBMIT
    if (interaction.isModalSubmit() && interaction.customId === 'activate_modal') {
      const id = interaction.user.id;
      const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));

      if (!creditsToSpend || creditsToSpend < 1 || creditsToSpend > users[id]?.credits) {
        return interaction.editReply({ content: '❌ Invalid or insufficient credits' });
      }

      if (slots.filter(s => s.expiry > Date.now()).length >= 6) {
        return interaction.editReply({ content: '❌ All 6 slots are currently occupied!' });
      }

      const ms = creditsToSpend * 2 * 60 * 60 * 1000;
      const key = await createLuarmorKey(id, ms);

      users[id].credits -= creditsToSpend;
      slots.push({ key, ownerId: id, expiry: Date.now() + ms });
      saveUsers();
      saveSlots();

      await interaction.editReply({
        content: `✅ **Slot activated!**\n**Key:** \`${key}\`\nExpires in ${formatTime(ms)}`
      });
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: 'Something went wrong internally.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.editReply({ content: 'Something went wrong internally.' }).catch(() => {});
    }
  }
});

// ===== AUTO CLEANUP =====
setInterval(() => {
  slots = slots.filter(s => s.expiry > Date.now());
  saveSlots();
}, 60000);

// ===== AUTO CRYPTO CHECK (BTC + LTC) =====
setInterval(async () => {
  console.log('Checking for new crypto deposits...');
  for (const id in users) {
    const user = users[id];
    for (const currency of ['btc', 'ltc']) {
      const address = user[currency];
      if (!address) continue;

      try {
        const res = await axios.get(`https://api.blockcypher.com/v1/${currency}/main/addrs/${address}`);
        const txs = res.data.txrefs || [];

        txs.forEach(tx => {
          if (tx.confirmations < 1 || user.processed?.includes(tx.tx_hash)) return;

          // Adjust rate: example 1 credit = 10,000 satoshis (0.0001 BTC/LTC)
          const credits = Math.floor(tx.value / 10000); // change divisor to fit your pricing

          if (credits <= 0) return;

          user.credits += credits;
          if (!user.processed) user.processed = [];
          user.processed.push(tx.tx_hash);
          saveUsers();

          console.log(`Added ${credits} credits to ${id} from ${currency} TX ${tx.tx_hash}`);

          client.users.fetch(id).then(u => {
            u.send(`✅ ${currency.toUpperCase()} payment received!\nAdded **${credits} credits**.\nYou now have **${user.credits}**. Use /activate_slot!`).catch(() => {});
          }).catch(() => {});
        });
      } catch (err) {
        console.error(`Crypto check error for ${id} (${currency}):`, err.message);
      }
    }
  }
}, 30000); // every 30 seconds

// ===== START =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  logOutboundIP();
});

client.login(process.env.BOT_TOKEN);
