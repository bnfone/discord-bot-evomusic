// /structs/MusicQueue.ts
// This module manages the music queue, playback and control buttons.
// Advertisement functionality is integrated so that after a configured number of normal songs,
// an advertisement is played (without being displayed in the queue).

import {
  AudioPlayer,
  AudioPlayerPlayingState,
  AudioPlayerState,
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  entersState,
  NoSubscriberBehavior,
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionState,
  VoiceConnectionStatus,
  StreamType
} from "@discordjs/voice";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  CommandInteraction,
  GuildMember,
  Interaction,
  Message,
  TextChannel
} from "discord.js";
import { createReadStream } from "fs";
import { promisify } from "node:util";
import { bot } from "../index";
import { QueueOptions } from "../interfaces/QueueOptions";
import { config } from "../utils/config";
import { i18n } from "../utils/i18n";
import { canModifyQueue } from "../utils/queue";
import { Song } from "./Song";
import { safeReply } from "../utils/safeReply";
import { logSongPlayed, logSongSkipped } from "../utils/stats";
import { getRandomAudioFileForAd, sendAdvertisementEmbed } from "../utils/advertisements";
import { handleError } from "../utils/errorHandler";
import { addFavorite, removeFavorite, getUserFavorites } from "../utils/favorites";
import { log, error as logError } from "../utils/logger";

const wait = promisify(setTimeout);

export class MusicQueue {
  public readonly interaction: CommandInteraction;
  public readonly connection: VoiceConnection;
  public readonly player: AudioPlayer;
  public readonly textChannel: TextChannel;
  public readonly bot = bot;

  public resource: AudioResource | undefined;
  public songs: Song[] = [];
  public volume = config.DEFAULT_VOLUME || 100;
  public loop = false;
  public muted = false;
  public waitTimeout: NodeJS.Timeout | null = null;
  private queueLock = false;
  private readyLock = false;
  private stopped = false;
  // Record the start time for the currently playing song
  private currentSongStartTime: number | null = null;
  // Counter for the number of normal songs played since the last advertisement
  private advertisementCounter: number = 0;

  /**
   * Constructs a new MusicQueue instance, setting up the audio player,
   * voice connection, and event listeners to manage voice state changes
   * and audio playback. It also handles network state changes to ensure
   * a stable connection for audio streaming.
   * @param options - The initialization options for the MusicQueue
   */
  public constructor(options: QueueOptions) {
    Object.assign(this, options);

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });
    this.connection.subscribe(this.player);

    const networkStateChangeHandler = (
      oldNetworkState: VoiceConnectionState,
      newNetworkState: VoiceConnectionState
    ) => {
      const newUdp = Reflect.get(newNetworkState, "udp");
      clearInterval(newUdp?.keepAliveInterval);
    };

    // Voice connection handling
    this.connection.on("stateChange", async (oldState, newState) => {
      Reflect.get(oldState, "networking")?.off("stateChange", networkStateChangeHandler);
      Reflect.get(newState, "networking")?.on("stateChange", networkStateChangeHandler);

      if (newState.status === VoiceConnectionStatus.Disconnected) {
        if (
          newState.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
          newState.closeCode === 4014
        ) {
          // Possibly kicked out etc.
          try {
            this.stop();
          } catch (e) {
            console.error(e);
            this.stop();
          }
        } else if (this.connection.rejoinAttempts < 5) {
          // Wait and then try to rejoin
          await wait((this.connection.rejoinAttempts + 1) * 5000);
          this.connection.rejoin();
        } else {
          this.connection.destroy();
        }
      } else if (
        !this.readyLock &&
        (newState.status === VoiceConnectionStatus.Connecting ||
          newState.status === VoiceConnectionStatus.Signalling)
      ) {
        this.readyLock = true;
        try {
          await entersState(this.connection, VoiceConnectionStatus.Ready, 20000);
        } catch {
          if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            try {
              this.connection.destroy();
            } catch {}
          }
        } finally {
          this.readyLock = false;
        }
      }
    });

    // Player state changes
    this.player.on("stateChange", async (oldState: AudioPlayerState, newState: AudioPlayerState) => {
      // When a song finishes (transition from Playing to Idle)
      if (
        oldState.status === AudioPlayerStatus.Playing &&
        newState.status === AudioPlayerStatus.Idle
      ) {
        const currentMetadata = this.resource ? this.resource.metadata : null;
        const isAd = currentMetadata && (currentMetadata as Song).title === "Advertisement";
    
        // For a normal song, log play or skip statistics:
        if (!isAd && this.resource) {
          if (this.currentSongStartTime !== null) {
            const currentSong = this.resource.metadata as Song;
            const playedMs = Date.now() - this.currentSongStartTime;
            const playedPercentage = playedMs / (currentSong.duration * 1000);
            const requesterId = (currentSong as any).requesterId || "unknown";
            if (playedPercentage >= 0.5) {
              await logSongPlayed(requesterId, currentSong.url, playedMs / 60000, "youtube", currentSong.title);
            } else {
              await logSongSkipped(requesterId, currentSong.url, currentSong.title);
            }
          }
          this.advertisementCounter++;
        }
        this.currentSongStartTime = null;
    
        // Remove the song from the queue (looping handled if enabled)
        if (!isAd) {
          if (this.loop && this.songs.length) {
            this.songs.push(this.songs.shift()!);
          } else {
            this.songs.shift();
            if (!this.songs.length) {
              return this.stop();
            }
          }
        }
        if (!isAd && config.ADVERTISEMENT_INTERVAL && this.advertisementCounter >= config.ADVERTISEMENT_INTERVAL) {
          this.advertisementCounter = 0;
          await this.playAdvertisement();
          return;
        }
        if (this.songs.length) {
          this.processQueue();
        }
      } else if (
        oldState.status === AudioPlayerStatus.Buffering &&
        newState.status === AudioPlayerStatus.Playing
      ) {
        this.currentSongStartTime = Date.now();
        if (this.resource && typeof (this.resource.metadata as any).startMessage === "function") {
          this.sendPlayingMessage(newState as AudioPlayerPlayingState);
        }
      }
    });

    // Player error event with unified error handling
    this.player.on("error", async (error) => {
      console.error("[MusicQueue] AudioPlayer encountered an error:", error);
      if (this.interaction) {
        await handleError(this.interaction, error);
      } else {
        this.textChannel.send(i18n.__("common.errorCommand")).catch(console.error);
      }
      if (this.loop && this.songs.length) {
        this.songs.push(this.songs.shift()!);
      } else {
        this.songs.shift();
      }
      this.processQueue();
    });
  }

  /**
   * Enqueues (appends) new songs to the queue and triggers processing.
   * @param songs - The songs to add to the queue
   */
  public enqueue(...songs: Song[]) {
    if (this.waitTimeout !== null) clearTimeout(this.waitTimeout);
    this.waitTimeout = null;
    this.stopped = false;
    this.songs = this.songs.concat(songs);
    this.processQueue();
  }

  /**
   * Stops the queue entirely: clears songs, stops the player,
   * and optionally leaves the voice channel after a timeout.
   */
  public stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.loop = false;
    this.songs = [];
    this.player.stop();
    if (!config.PRUNING) {
      this.textChannel.send(i18n.__("play.queueEnded")).catch(console.error);
    }
    if (this.waitTimeout !== null) return;
    this.waitTimeout = setTimeout(() => {
      if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try {
          this.connection.destroy();
        } catch {}
      }
      bot.queues.delete(this.interaction.guild!.id);
      if (!config.PRUNING) {
        this.textChannel.send(i18n.__("play.leaveChannel"));
      }
    }, config.STAY_TIME * 1000);
  }

  /**
   * Attempts to play the next song in the queue if the player is idle
   * and the queue is unlocked.
   */
  public async processQueue(): Promise<void> {
    if (this.queueLock || this.player.state.status !== AudioPlayerStatus.Idle) {
      return;
    }
    if (!this.songs.length) {
      return this.stop();
    }
    this.queueLock = true;
    const nextSong = this.songs[0];
    try {
      const resource = await nextSong.makeResource();
      if (!resource) {
        this.songs.shift();
        return this.processQueue();
      }
      this.resource = resource;
      this.player.play(this.resource);
      this.resource.volume?.setVolumeLogarithmic(this.volume / 100);
      this.currentSongStartTime = Date.now();
    } catch (error) {
      console.error(`Error playing song: ${error}`);
      this.songs.shift();
      if (this.textChannel && this.interaction) {
        await handleError(this.interaction, error as Error);
      }
    } finally {
      this.queueLock = false;
      if (this.songs.length) this.processQueue();
    }
  }

  /**
   * Plays an advertisement. This method is called when the advertisement counter
   * reaches the configured interval. It does not add the advertisement to the queue.
   */
  private async playAdvertisement(): Promise<void> {
    if (config.DEBUG) console.log("[MusicQueue] Advertisement interval reached. Playing advertisement...");
  
    // Destructure the returned object from sendAdvertisementEmbed
    const { message: adMessage, adConfig } = await sendAdvertisementEmbed(this.textChannel);
  
    // Get the audio file corresponding to the selected ad configuration
    const adFilePath = getRandomAudioFileForAd(adConfig);
    if (!adFilePath) {
      if (config.DEBUG) console.log("[MusicQueue] No advertisement file available. Skipping ad.");
      return this.processQueue();
    }
  
    if (adMessage) {
      const adCollector = adMessage.createMessageComponentCollector({
        filter: (i: Interaction): i is ButtonInteraction =>
          i.isButton() && i.message.id === adMessage.id && i.customId === "ad_skip",
        time: 30000
      });
      adCollector.on("collect", async (interaction: ButtonInteraction) => {
        await this.handleAdSkip(interaction);
        adCollector.stop();
      });
    }
  
    try {
      const adStream = createReadStream(adFilePath);
      const { createAudioResource } = await import("@discordjs/voice");
      const adResource = createAudioResource(adStream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
        metadata: { title: "Advertisement" }
      });
      this.resource = adResource;
      this.player.play(this.resource);
      this.resource.volume?.setVolumeLogarithmic(this.volume / 100);
      this.currentSongStartTime = Date.now();
    } catch (error) {
      console.error("[MusicQueue] Error playing advertisement:", error);
    }
  }

  /**
   * Shuffles the entire queue (including the first position),
   * so that the very first song to play is random.
   */
  public shuffle(): void {
    if (this.songs.length < 2) return;
    for (let i = this.songs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.songs[i], this.songs[j]] = [this.songs[j], this.songs[i]];
    }
  }

  // -------------- Button Handlers --------------

  private async handleSkip(interaction: ButtonInteraction): Promise<void> {
    await this.bot.slashCommandsMap.get("skip")!.execute(interaction);
  }

  /**
   * Handles the "Skip Ad" button interaction.
   * This will stop the current advertisement and resume processing the queue.
   */
  private async handleAdSkip(interaction: ButtonInteraction): Promise<void> {
    log(`User ${interaction.user.id} requested to skip the advertisement.`);
    this.player.stop();
    await interaction.reply({ content: i18n.__("advertisement.skipped"), ephemeral: true });
    if (this.songs.length) {
      this.processQueue();
    }
  }

  /**
   * Handles toggling the favorite status of the current song.
   */
  private async handleFavoriteToggler(interaction: ButtonInteraction): Promise<void> {
    if (!this.resource) {
      await interaction.reply({ content: i18n.__("favorite.toggle.noSong"), ephemeral: true }).catch(logError);
      return;
    }
    const song = this.resource.metadata as Song;
    const userId = interaction.user.id;
    const userFavs = getUserFavorites(userId);
    try {
      if (userFavs.includes(song.url)) {
        removeFavorite(userId, song.url);
        log(`User ${userId} removed favorite: ${song.title}`);
        await interaction.reply({ content: i18n.__mf("favorite.toggle.removed", { title: song.title }), ephemeral: true });
      } else {
        addFavorite(userId, song.url, song.title);
        log(`User ${userId} added favorite: ${song.title}`);
        await interaction.reply({ content: i18n.__mf("favorite.toggle.added", { title: song.title }), ephemeral: true });
      }
    } catch (err) {
      logError("[MusicQueue] Error toggling favorite status:", err as Error);
      await interaction.reply({ content: i18n.__("favorite.toggle.error"), ephemeral: true }).catch(logError);
    }
  }

  private async handlePlayPause(interaction: ButtonInteraction): Promise<void> {
    if (this.player.state.status === AudioPlayerStatus.Playing) {
      await this.bot.slashCommandsMap.get("pause")!.execute(interaction);
    } else {
      await this.bot.slashCommandsMap.get("resume")!.execute(interaction);
    }
  }

  private async handleMute(interaction: ButtonInteraction): Promise<void> {
    if (!canModifyQueue(interaction.member as GuildMember)) return;
    this.muted = !this.muted;
    if (this.muted) {
      this.resource?.volume?.setVolumeLogarithmic(0);
      safeReply(interaction, i18n.__mf("play.mutedSong", { author: interaction.user })).catch(console.error);
    } else {
      this.resource?.volume?.setVolumeLogarithmic(this.volume / 100);
      safeReply(interaction, i18n.__mf("play.unmutedSong", { author: interaction.user })).catch(console.error);
    }
  }

  private async handleDecreaseVolume(interaction: ButtonInteraction): Promise<void> {
    if (this.volume === 0) return;
    if (!canModifyQueue(interaction.member as GuildMember)) return;
    this.volume = Math.max(this.volume - 10, 0);
    this.resource?.volume?.setVolumeLogarithmic(this.volume / 100);
    safeReply(interaction, i18n.__mf("play.decreasedVolume", { author: interaction.user, volume: this.volume })).catch(console.error);
  }

  private async handleIncreaseVolume(interaction: ButtonInteraction): Promise<void> {
    if (this.volume === 100) return;
    if (!canModifyQueue(interaction.member as GuildMember)) return;
    this.volume = Math.min(this.volume + 10, 100);
    this.resource?.volume?.setVolumeLogarithmic(this.volume / 100);
    safeReply(interaction, i18n.__mf("play.increasedVolume", { author: interaction.user, volume: this.volume })).catch(console.error);
  }

  private async handleLoop(interaction: ButtonInteraction): Promise<void> {
    await this.bot.slashCommandsMap.get("loop")!.execute(interaction);
  }

  private async handleShuffle(interaction: ButtonInteraction): Promise<void> {
    await this.bot.slashCommandsMap.get("shuffle")!.execute(interaction);
  }

  private async handleStop(interaction: ButtonInteraction): Promise<void> {
    await this.bot.slashCommandsMap.get("stop")!.execute(interaction);
  }

  private commandHandlers = new Map<string, (interaction: ButtonInteraction) => Promise<void>>([
    ["skip", this.handleSkip],
    ["play_pause", this.handlePlayPause],
    ["mute", this.handleMute],
    ["decrease_volume", this.handleDecreaseVolume],
    ["increase_volume", this.handleIncreaseVolume],
    ["loop", this.handleLoop],
    ["shuffle", this.handleShuffle],
    ["stop", this.handleStop],
    ["favorite_toggler", this.handleFavoriteToggler],
    ["ad_skip", this.handleAdSkip]
  ]);

  private createButtonRow(): ActionRowBuilder<ButtonBuilder>[] {
    const firstRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("skip").setLabel("⏭️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("play_pause").setLabel("⏯️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("mute").setLabel("🔇").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("decrease_volume").setLabel("🔉").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("increase_volume").setLabel("🔊").setStyle(ButtonStyle.Secondary)
    );
    const secondRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("loop").setLabel("🔁").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("shuffle").setLabel("🔀").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("favorite_toggler").setLabel("🩶").setStyle(ButtonStyle.Secondary)
    );
    return [firstRow, secondRow];
  }

  /**
   * Sends a message indicating which song is playing, including player controls
   * as interactive buttons. If the current resource does not implement startMessage (e.g. advertisement),
   * the function will simply return without sending a message.
   */
  private async sendPlayingMessage(newState: AudioPlayerPlayingState): Promise<void> {
    const metadata = newState.resource.metadata;
    if (typeof (metadata as any).startMessage !== "function") {
      return;
    }
    const song = metadata as Song;
    let playingMessage: Message;
    try {
      playingMessage = await this.textChannel.send({
        content: song.startMessage(),
        components: this.createButtonRow()
      });
    } catch (error: unknown) {
      console.error(error);
      if (error instanceof Error) {
        await this.textChannel.send(error.message).catch(console.error);
      }
      return;
    }
    const filter = (i: Interaction): i is ButtonInteraction =>
      i.isButton() && i.message.id === playingMessage.id;
    const collector = playingMessage.createMessageComponentCollector({
      filter: (i: Interaction): i is ButtonInteraction =>
        i.isButton() && i.message.id === playingMessage.id,
      time: song.duration > 0 ? song.duration * 1000 : 60000
    });
    collector.on("collect", async (interaction: ButtonInteraction) => {
      const handler = this.commandHandlers.get(interaction.customId);
      if (["skip", "stop"].includes(interaction.customId)) collector.stop();
      if (handler) await handler.call(this, interaction);
    });
    collector.on("end", () => {
      playingMessage.edit({ components: [] }).catch(console.error);
      if (config.PRUNING) {
        setTimeout(() => {
          playingMessage.delete().catch(() => {});
        }, 3000);
      }
    });
  }

  // Getter: isPlaying
  get isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  // Starts playback by processing the queue
  public play(): void {
    this.processQueue();
  }
}