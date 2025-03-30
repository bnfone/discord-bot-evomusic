export interface Config {
  SPOTIFY_CLIENT_SECRET: string;
  SPOTIFY_CLIENT_ID: string;
  TOKEN: string;
  MAX_PLAYLIST_SIZE: number;
  PRUNING: boolean;
  STAY_TIME: number;
  DEFAULT_VOLUME: number;
  LOCALE: string;
  DEBUG?: boolean;
  ADVERTISEMENT_INTERVAL?: number;
  LOG_TERMINAL?: boolean;
  LOG_COMMANDS?: boolean;
  pipedApiUrl?: string;
  usePipedFallback?: boolean;
  USE_METADATA_EXTRACTION?: boolean;
}
