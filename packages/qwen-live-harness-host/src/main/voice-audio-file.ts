import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { liveMessage } from 'qwen-live-harness/i18n';

export async function readVoiceAudioFile(
  path: string,
): Promise<{ name: string; data: Uint8Array }> {
  if (!['.wav', '.mp3', '.m4a'].includes(extname(path).toLowerCase()))
    throw new Error(liveMessage('voice.sampleInvalid'));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0)
      throw new Error(liveMessage('voice.sampleInvalid'));
    if (stat.size > 10 * 1024 * 1024)
      throw new Error(liveMessage('voice.sampleTooLarge'));
    // Read at most one bounded buffer even if the selected file grows concurrently.
    const data = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== data.length)
      throw new Error(liveMessage('voice.sampleInvalid'));
    return { name: basename(path).slice(0, 256), data };
  } finally {
    await file.close();
  }
}
