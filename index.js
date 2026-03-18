require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const axios = require('axios');
const fs = require('fs');

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

// Save users function
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Luarmor key generator
async function createLuarmorKey(discordId, hours) {
  const expiryUnix = Math.floor(Date.now() / 1000) + (hours * 3600);
  await axios.post(`https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`, {
    auth_expire: expiryUnix,
    discord_id: discordId
  }, {
    headers: { Authorization: process.env.LUARMOR_API_KEY }
  });

  const list = await axios.get(`https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`, {
    headers: { Authorization: process.env.LUARMOR_API_KEY }
  });

  const keyData = list.data.users?.find(u => u.discord_id === discordId);
  return keyData?.key || "ERROR_RETRIEVING_KEY";
}

// Panel command (run this once in your channel)
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === 'panel' && process.env.ADMIN_IDS.includes(interaction.user.id)) {
    const embed = new EmbedBuilder()
      .setTitle('🔑 Luarmor Slot System')
      .setDescription('1 Credit = 1€ = 2 Hours\nMax 6 slots per user')
      .setColor(0x00ff00);

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId('get_credits').setLabel('🛒 Get Credits').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('activate_slot').setLabel('⚡ Activate Slot').setStyle(ButtonStyle.Success)
      );

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  if (interaction.commandName === 'givecredits' && process.env.ADMIN_IDS.includes(interaction.user.id)) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (!users[target.id]) users[target.id] = { credits: 0, slots: [] };
    users[target.id].credits += amount;
    saveUsers();
    await interaction.reply(`✅ Gave **${amount} credits** to ${target.tag}`);
  }
});

// Button & Modal handling
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const userId = interaction.user.id;
  if (!users[userId]) users[userId] = { credits: 0, slots: [] };

  if (interaction.customId === 'get_credits') {
    await interaction.reply({
      content: `🛒 Go to <#YOUR_PURCHASE_CHANNEL_ID> and open a ticket or DM an admin!\nYou currently have **${users[userId].credits} credits**.`,
      ephemeral: true
    });
  }

  if (interaction.customId === 'activate_slot') {
    if (users[userId].slots.length >= 6) {
      return interaction.reply({ content: '❌ You already have the maximum 6 slots!', ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId('activate_modal')
      .setTitle('Activate Slot');

    const creditsInput = new TextInputBuilder()
      .setCustomId('credits_amount')
      .setLabel('How many credits to spend?')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const row = new ActionRowBuilder().addComponents(creditsInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }
});

// Modal submit
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;

  if (interaction.customId === 'activate_modal') {
    const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));
    const userData = users[interaction.user.id];

    if (creditsToSpend < 1 || creditsToSpend > userData.credits) {
      return interaction.reply({ content: '❌ Invalid amount or not enough credits!', ephemeral: true });
    }

    const hours = creditsToSpend * 2;
    try {
      const key = await createLuarmorKey(interaction.user.id, hours);

      userData.slots.push({ key, expiry: Date.now() + hours * 3600000 });
      userData.credits -= creditsToSpend;
      saveUsers();

      await interaction.reply({
        content: `✅ **Slot activated!**\n\n**Key:** \`${key}\`\n**Expires in:** ${hours} hours\n\nPaste this key in your script.`,
        ephemeral: true
      });
    } catch (err) {
      await interaction.reply({ content: '❌ Failed to generate key. Check Luarmor API key/IP whitelist.', ephemeral: true });
    }
  }
});

// Login
client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});
console.log('=== DEBUG: BOT_TOKEN check ===');
console.log('BOT_TOKEN exists?', !!process.env.BOT_TOKEN);
console.log('BOT_TOKEN length:', process.env.BOT_TOKEN?.length ?? 'undefined');
console.log('BOT_TOKEN first 10 chars:', process.env.BOT_TOKEN?.slice(0, 10) ?? 'undefined');
console.log('BOT_TOKEN last 10 chars:', process.env.BOT_TOKEN?.slice(-10) ?? 'undefined');
console.log('=== END DEBUG ===');
client.login(process.env.BOT_TOKEN);
