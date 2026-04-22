const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const play = require('play-dl');
require('dotenv/config');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Store active connections and players
const musicQueues = new Map();

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    
    // Register slash command
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    
    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [
                new SlashCommandBuilder()
                    .setName('ms')
                    .setDescription('Play music from a link in your voice channel')
                    .addStringOption(option =>
                        option.setName('link')
                            .setDescription('YouTube or music link')
                            .setRequired(true))
                    .toJSON()
            ] }
        );
        console.log('✅ Slash commands registered');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
});

async function playMusic(guildId, voiceChannel, textChannel, url) {
    try {
        // Get or create queue for this guild
        if (!musicQueues.has(guildId)) {
            musicQueues.set(guildId, { connection: null, player: null, queue: [], current: null });
        }
        
        const guildQueue = musicQueues.get(guildId);
        
        // Validate URL and get stream
        let stream;
        let title;
        
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            const video = await play.video_info(url);
            title = video.video_details.title;
            stream = await play.stream(url);
        } else {
            // Try searching YouTube
            const searchResult = await play.search(url, { limit: 1 });
            if (searchResult.length === 0) throw new Error('No results found');
            const video = await play.video_info(searchResult[0].url);
            title = video.video_details.title;
            stream = await play.stream(searchResult[0].url);
        }
        
        const resource = createAudioResource(stream.stream, {
            inputType: stream.type,
            inlineVolume: true
        });
        
        resource.volume.setVolume(0.5);
        
        // If no connection exists, create one
        if (!guildQueue.connection) {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator
            });
            
            guildQueue.connection = connection;
            guildQueue.player = createAudioPlayer();
            
            connection.subscribe(guildQueue.player);
            
            // Handle connection errors
            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                musicQueues.delete(guildId);
                if (textChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setDescription('🔌 Disconnected from voice channel');
                    await textChannel.send({ embeds: [embed] });
                }
            });
        }
        
        // Add to queue
        guildQueue.queue.push({ resource, title, url });
        
        // Send confirmation
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setDescription(`✅ Added to queue: **${title}**\nPosition: ${guildQueue.queue.length}`);
        await textChannel.send({ embeds: [embed] });
        
        // Log to log channel
        const logChannel = client.channels.cache.get(process.env.LOG_CHANNEL_ID);
        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('🎵 Music Played')
                .addFields(
                    { name: 'User', value: `<@${textChannel.lastMessage?.author?.id || 'Unknown'}>` },
                    { name: 'Song', value: title },
                    { name: 'Channel', value: `<#${textChannel.id}>` }
                )
                .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
        }
        
        // Start playing if not already
        if (guildQueue.player.state.status !== AudioPlayerStatus.Playing) {
            playNext(guildId, textChannel);
        }
        
    } catch (error) {
        console.error('Error playing music:', error);
        const errorEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setDescription(`❌ Error: ${error.message}`);
        await textChannel.send({ embeds: [errorEmbed] });
    }
}

async function playNext(guildId, textChannel) {
    const guildQueue = musicQueues.get(guildId);
    if (!guildQueue || guildQueue.queue.length === 0) {
        // No more songs, disconnect after 5 minutes of inactivity
        setTimeout(() => {
            const currentQueue = musicQueues.get(guildId);
            if (currentQueue && currentQueue.queue.length === 0 && currentQueue.player.state.status !== AudioPlayerStatus.Playing) {
                if (currentQueue.connection) {
                    currentQueue.connection.destroy();
                    musicQueues.delete(guildId);
                    const embed = new EmbedBuilder()
                        .setColor(0xFFA500)
                        .setDescription('👋 Queue empty, disconnected from voice channel');
                    if (textChannel) textChannel.send({ embeds: [embed] });
                }
            }
        }, 300000);
        return;
    }
    
    const nextSong = guildQueue.queue.shift();
    guildQueue.current = nextSong;
    
    guildQueue.player.play(nextSong.resource);
    
    const nowPlayingEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setDescription(`🎵 Now playing: **${nextSong.title}**`);
    if (textChannel) await textChannel.send({ embeds: [nowPlayingEmbed] });
    
    guildQueue.player.once(AudioPlayerStatus.Idle, () => {
        playNext(guildId, textChannel);
    });
    
    guildQueue.player.on('error', error => {
        console.error('Player error:', error);
        playNext(guildId, textChannel);
    });
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    if (interaction.commandName !== 'ms') return;
    
    await interaction.deferReply();
    
    const link = interaction.options.getString('link');
    const member = interaction.member;
    const voiceChannel = member.voice.channel;
    
    // Check if user is in a voice channel
    if (!voiceChannel) {
        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setDescription('❌ You must be in a voice channel to use this command!');
        return await interaction.editReply({ embeds: [embed] });
    }
    
    // Check bot permissions
    const botMember = interaction.guild.members.me;
    if (!voiceChannel.joinable) {
        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setDescription('❌ I don\'t have permission to join that voice channel!');
        return await interaction.editReply({ embeds: [embed] });
    }
    
    if (!voiceChannel.speakable) {
        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setDescription('❌ I don\'t have permission to speak in that voice channel!');
        return await interaction.editReply({ embeds: [embed] });
    }
    
    // Send to panel channel if configured
    const panelChannel = client.channels.cache.get(process.env.PANEL_CHANNEL_ID);
    if (panelChannel) {
        const panelEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setDescription(`🎵 ${interaction.user.tag} is playing music in ${voiceChannel.name}`);
        await panelChannel.send({ embeds: [panelEmbed] });
    }
    
    await interaction.editReply('🎵 Processing your request...');
    await playMusic(interaction.guildId, voiceChannel, interaction.channel, link);
});

client.login(process.env.BOT_TOKEN);