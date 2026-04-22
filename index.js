import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } from '@discordjs/voice';
import { stream } from 'play-dl';
import dotenv from 'dotenv';

dotenv.config();

// Environment variables
const TOKEN = process.env.BOT_TOKEN;
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

// Validate required env vars
if (!TOKEN) {
    console.error('❌ BOT_TOKEN is required in environment variables');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Store active connections
const activePlayers = new Map();

client.once('ready', async () => {
    console.log(`✅ Bot online as ${client.user.tag}`);
    
    // Register slash command
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    
    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [
                new SlashCommandBuilder()
                    .setName('ms')
                    .setDescription('Play music from a link')
                    .addStringOption(option =>
                        option.setName('link')
                            .setDescription('YouTube or music link')
                            .setRequired(true))
            ] }
        );
        console.log('✅ Slash command /ms registered');
    } catch (error) {
        console.error('Failed to register command:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'ms') return;
    
    await interaction.deferReply();
    
    const link = interaction.options.getString('link');
    const voiceChannel = interaction.member.voice.channel;
    
    // Check if user is in voice
    if (!voiceChannel) {
        return await interaction.editReply('❌ You need to be in a voice channel first!');
    }
    
    // Check bot permissions
    if (!voiceChannel.joinable) {
        return await interaction.editReply('❌ I cannot join your voice channel!');
    }
    
    try {
        // Get video info
        const videoInfo = await playdl.video_info(link);
        const title = videoInfo.video_details.title;
        
        // Get audio stream
        const streamSource = await playdl.stream(link);
        const resource = createAudioResource(streamSource.stream, {
            inputType: streamSource.type
        });
        
        // Join voice channel
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator
        });
        
        // Create or reuse audio player
        let player = activePlayers.get(interaction.guildId);
        if (!player) {
            player = createAudioPlayer();
            connection.subscribe(player);
            activePlayers.set(interaction.guildId, player);
            
            // Cleanup when done
            player.on(AudioPlayerStatus.Idle, () => {
                setTimeout(() => {
                    if (player.state.status === AudioPlayerStatus.Idle) {
                        connection.destroy();
                        activePlayers.delete(interaction.guildId);
                    }
                }, 300000); // Disconnect after 5 min idle
            });
        }
        
        // Play the audio
        player.play(resource);
        
        // Send success message
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🎵 Now Playing')
            .setDescription(`[${title}](${link})`)
            .setFooter({ text: `Requested by ${interaction.user.tag}` });
        
        await interaction.editReply({ embeds: [embed] });
        
        // Log to panel channel if configured
        if (PANEL_CHANNEL_ID) {
            const panelChannel = client.channels.cache.get(PANEL_CHANNEL_ID);
            if (panelChannel) {
                panelChannel.send(`🎵 ${interaction.user.tag} is playing: ${title}`);
            }
        }
        
        // Log to log channel if configured
        if (LOG_CHANNEL_ID) {
            const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
            if (logChannel) {
                logChannel.send(`📝 Music played by ${interaction.user.tag} in ${voiceChannel.name}: ${title}`);
            }
        }
        
    } catch (error) {
        console.error(error);
        await interaction.editReply('❌ Failed to play that link. Make sure it\'s a valid YouTube URL.');
    }
});

client.login(TOKEN);
