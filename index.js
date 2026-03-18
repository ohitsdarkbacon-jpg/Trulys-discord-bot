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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const USERS_FILE = './users.json';
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : {};

const MAX_SLOTS = 6;
let globalSlots = []; // { userId, key, expiry }

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ================= COMMANDS =================
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Open admin panel'),
  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits to a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Target user')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Credits amount')
        .setRequired(true))
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
  } catch (err) {
    console.error(err);
  }
}

// ================= LUARMOR KEY =================
async function createLuarmorKey(hours) {
  const expiryUnix = Math.floor(Date.now() / 1000) + hours * 3600;

  try {
    const response = await axios.post(
      `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
      { auth_expire: expiryUnix },
      { headers: { Authorization: process.env.LUARMOR_API_KEY } }
    );

    // Recursively find any string that looks like a key
    const findKey = (obj) => {
      if (typeof obj === 'string' && /^[A-Za-z0-9]{6,}$/.test(obj)) return obj;
      if (typeof obj === 'object' && obj !== null) {
        for (const value of Object.values(obj)) {
          const result = findKey(value);
          if (result) return result;
        }
      }
      return null;
    };

    const key = findKey(response.data);
    if (!key) throw new Error('Key not found in response');

    return { key, expiry: expiryUnix };
  } catch (err) {
    console.error('Luarmor key generation error:', err.response?.data || err.message);
    throw new Error('Failed to generate Luarmor key');
  }
}

// ================= SLOT UI =================
function generateSlotsEmbed(client) {
  const embed = new EmbedBuilder()
    .setTitle('🎟️ Global Slot Status')
    .setColor(0x0099ff);

  for (let i = 0; i < MAX_SLOTS; i++) {
    const slot = globalSlots[i];
    if (slot) {
      const user = client.users.cache.get(slot.userId);
      const remainingHours = Math.max(0, Math.floor((slot.expiry * 1000 - Date.now()) / 3600000));
      embed.addFields({
        name: `Slot ${i + 1}`,
        value: `✅ Taken by ${user ? user.tag : 'Unknown'}\n⏱ Remaining: ${remainingHours}h`
      });
    } else {
      embed.addFields({ name: `Slot ${i + 1}`, value: '🟢 Available' });
    }
  }

  return embed;
}

// ================= COMMAND HANDLER =================
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'panel' && process.env.ADMIN_IDS.split(',').includes(interaction.user.id)) {
    const embed = new EmbedBuilder()
      .setTitle('🔑 Luarmor Slot System')
      .setDescription('1 Credit = 1€ = 2 Hours\nMax 6 slots total')
      .setColor(0x00ff00);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('get_credits').setLabel('🛒 Get Credits').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('activate_slot').setLabel('⚡ Activate Slot').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('view_slots').setLabel('📊 View Slots').setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  if (interaction.commandName === 'givecredits' && process.env.ADMIN_IDS.split(',').includes(interaction.user.id)) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    if (!users[target.id]) users[target.id] = { credits: 0 };
    users[target.id].credits += amount;
    saveUsers();

    await interaction.reply(`✅ Gave **${amount} credits** to ${target.tag}`);
  }
});

// ================= BUTTON HANDLER =================
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const userId = interaction.user.id;
  if (!users[userId]) users[userId] = { credits: 0 };

  if (interaction.customId === 'get_credits') {
    await interaction.reply({
      content: `🛒 Go to <#${process.env.PURCHASE_CHANNEL_ID}> to buy credits!\nYou have **${users[userId].credits} credits**.`,
      ephemeral: true
    });
  }

  if (interaction.customId === 'activate_slot') {
    if (globalSlots.length >= MAX_SLOTS) {
      return interaction.reply({ content: '❌ All 6 slots are currently taken!', ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId('activate_modal')
      .setTitle('Activate Slot');

    const input = new TextInputBuilder()
      .setCustomId('credits_amount')
      .setLabel('Credits to spend')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  if (interaction.customId === 'view_slots') {
    const embed = generateSlotsEmbed(client);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ================= MODAL HANDLER =================
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit() || interaction.customId !== 'activate_modal') return;

  const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));
  const userData = users[interaction.user.id];

  if (!creditsToSpend || creditsToSpend > userData.credits) {
    return interaction.reply({ content: '❌ Invalid or insufficient credits', ephemeral: true });
  }

  if (globalSlots.length >= MAX_SLOTS) {
    return interaction.reply({ content: '❌ All 6 slots are currently full!', ephemeral: true });
  }

  const hours = creditsToSpend * 2;

  try {
    const { key, expiry } = await createLuarmorKey(hours);

    globalSlots.push({
      userId: interaction.user.id,
      key,
      expiry
    });

    userData.credits -= creditsToSpend;
    saveUsers();

    await interaction.reply({
      content: `✅ **Slot activated!**\n**Key:** \`${key}\`\n**Expires in:** ${hours} hours`,
      ephemeral: true
    });
  } catch (err) {
    await interaction.reply({ content: `❌ Failed to generate key: ${err.message}`, ephemeral: true });
  }
});

// ================= CLEANUP =================
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  globalSlots = globalSlots.filter(slot => slot.expiry > now);
}, 60000); // every minute

// ================= READY =================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();

  // Log outbound IP
  https.get('https://api.ipify.org?format=json', res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const ip = JSON.parse(data).ip;
        console.log('====================================');
        console.log('CURRENT OUTBOUND IP:', ip);
        console.log('Check this IP in your Luarmor whitelist');
        console.log('====================================');
      } catch (e) {
        console.error('Failed to parse outbound IP:', e.message);
      }
    });
  }).on('error', e => console.error('Outbound IP check failed:', e.message));
});

client.login(process.env.BOT_TOKEN);
