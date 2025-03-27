import axios from "axios";
import { Readable } from "stream";

/**
 * Extracts the YouTube video ID from a given URL.
 * @param url - The full YouTube URL.
 * @returns The video ID or null if not found.
 */
export function extractYoutubeVideoId(url: string): string | null {
  const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})(?:\?|&|$)/);
  return match ? match[1] : null;
}

/**
 * Fetches the audio stream from the Piped API.
 * @param videoId - The YouTube video ID.
 * @param pipedApiUrl - The base URL of the Piped API instance.
 * @returns A readable stream containing the audio data.
 * @throws An error if the API response is not as expected.
 */
export async function fetchPipedAudioStream(videoId: string, pipedApiUrl: string): Promise<Readable> {
  const endpoint = `${pipedApiUrl}/streams/${videoId}`;
  const response = await axios.get(endpoint);
  
  if (response.status !== 200) {
    throw new Error(`Piped API responded with status ${response.status}`);
  }
  
  const data = response.data;
  if (!data.audioStreams || data.audioStreams.length === 0) {
    throw new Error("No audio streams found in Piped API response");
  }
  
  // Choose the first available audio stream (you can adjust the selection logic if needed)
  const audioStreamUrl = data.audioStreams[0].url;
  const streamResponse = await axios.get(audioStreamUrl, { responseType: "stream" });
  
  if (streamResponse.status !== 200) {
    throw new Error(`Failed to retrieve audio stream from Piped API, status ${streamResponse.status}`);
  }
  
  return streamResponse.data;
}