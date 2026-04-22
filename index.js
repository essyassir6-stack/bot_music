import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } from '@discordjs/voice';
import { stream, video_info } from 'play-dl';
import dotenv from 'dotenv';

dotenv.config();

// Environment variables only - no hardcoded values
const TOKEN = process.env.BOT_TOKEN;
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

// Validate required token
if (!TOKEN) {
    console.error('ERROR: BOT_TOKEN environment variable is required');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Store active connections per server
const connections = new Map();

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    // Register slash command
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    
    const commands = [
        new SlashCommandBuilder()
            .setName('ms')
            .setDescription('Play music from a link in your voice channel')
            .addStringOption(option =>
                option.setName('link')
                    .setDescription('YouTube or music link')
                    .setRequired(true)
            )
    ];
    
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Slash commands registered');
    } catch (error) {
        console.error('Failed to register commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'ms') return;
    
    await interaction.deferReply();
    
    const link = interaction.options.getString('link');
    const voiceChannel = interaction.member.voice.channel;
    
    // Validation
    if (!voiceChannel) {
        return await interaction.editReply('❌ You must be in a voice channel first');
    }
    
    if (!voiceChannel.joinable) {
        return await interaction.editReply('❌ I cannot join your voice channel');
    }
    
    try {
        // Get video info
        const videoData = await video_info(link);
        const title = videoData.video_details.title;
        
        // Get audio stream
        const audioStream = await stream(link);
        const resource = createAudioResource(audioStream.stream, {
            inputType: audioStream.type
        });
        
        // Join voice channel
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator
        });
        
        // Create or get audio player
        let player = connections.get(interaction.guildId);
        if (!player) {
            player = createAudioPlayer();
            connection.subscribe(player);
            connections.set(interaction.guildId, player);
            
            // Auto-disconnect after 5 minutes of inactivity
            player.on(AudioPlayerStatus.Idle, () => {
                setTimeout(() => {
                    if (player.state.status === AudioPlayerStatus.Idle) {
                        connection.destroy();
                        connections.delete(interaction.guildId);
                    }
                }, 300000);
            });
        }
        
        // Play music
        player.play(resource);
        
        // Success response
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🎵 Now Playing')
            .setDescription(`[${title}](${link})`)
            .setFooter({ text: `Requested by ${interaction.user.username}` });
        
        await interaction.editReply({ embeds: [embed] });
        
        // Optional: Log to panel channel
        if (PANEL_CHANNEL_ID) {
            const panelChannel = client.channels.cache.get(PANEL_CHANNEL_ID);
            if (panelChannel) {
                panelChannel.send(`🎵 ${interaction.user.tag} played: ${title}`);
            }
        }
        
        // Optional: Log to log channel
        if (LOG_CHANNEL_ID) {
            const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
            if (logChannel) {
                logChannel.send(`📝 ${interaction.user.tag} played "${title}" in ${voiceChannel.name}`);
            }
        }
        
    } catch (error) {
        console.error(error);
        await interaction.editReply('❌ Failed to play that link. Make sure it\'s a valid YouTube URL.');
    }
});

client.login(TOKEN);
