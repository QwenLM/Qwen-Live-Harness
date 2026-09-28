/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LiveVoiceState } from './host/types.js';

// Preset IDs, including spaces and accents, are provider values, not UI labels.
// Source: https://docs.qwencloud.com/developer-guides/speech/omni-voice-list
// Checked 2026-09-28. Custom IDs are account/model-specific and never enumerated here.
const OMNI_38: readonly string[] = [
  'Tina',
  'Cindy',
  'Liora Mira',
  'Raymond',
  'Zane',
  'Katerina',
  'Ryan',
  'Mia',
  'Cici',
  'Theo Calm',
  'Serena',
  'Maia',
  'Evan',
  'Qiao',
  'Momo',
  'Wil',
  'Angel',
  'Li Cassian',
  'Joyner',
  'Gold',
  'Jennifer',
  'Aiden',
  'Mione',
  'Sunny',
  'Dylan',
  'Eric',
  'Peter',
  'Joseph Chen',
  'Marcus',
  'Li',
  'Rocky',
  'Kiki',
  'Sohee',
  'Eliška',
  'Alek',
  'Arda',
  'Dolce',
  'Lenn',
  'Ono Anna',
  'Sonrisa',
  'Bodega',
  'Andre',
  'Radio Gol',
  'Rizky',
  'Roya',
  'Hana',
  'Jakub',
  'Griet',
  'Marina',
  'Siiri',
  'Ingrid',
  'Sigga',
  'Bea',
  'Chloe',
  'Emilien',
  'longanlingxin',
];
const OMNI_35: readonly string[] = [
  'Tina',
  'Cindy',
  'Liora Mira',
  'Sunnybobi',
  'Raymond',
  'Ethan',
  'Theo Calm',
  'Serena',
  'Harvey',
  'Maia',
  'Evan',
  'Qiao',
  'Momo',
  'Wil',
  'Angel',
  'Li Cassian',
  'Mia',
  'Joyner',
  'Gold',
  'Katerina',
  'Ryan',
  'Jennifer',
  'Aiden',
  'Mione',
  'Sunny',
  'Dylan',
  'Eric',
  'Peter',
  'Joseph Chen',
  'Marcus',
  'Li',
  'Rocky',
  'Sohee',
  'Lenn',
  'Ono Anna',
  'Sonrisa',
  'Bodega',
  'Emilien',
  'Andre',
  'Radio Gol',
  'Alek',
  'Rizky',
  'Roya',
  'Arda',
  'Hana',
  'Dolce',
  'Jakub',
  'Griet',
  'Eliska',
  'Marina',
  'Siiri',
  'Ingrid',
  'Sigga',
  'Bea',
  'Chloe',
  'Cherry',
  'Chelsie',
  'Kiki',
];
const OMNI_3: readonly string[] = [
  'Cherry',
  'Serena',
  'Ethan',
  'Chelsie',
  'Momo',
  'Vivian',
  'Moon',
  'Maia',
  'Kai',
  'Nofish',
  'Bella',
  'Jennifer',
  'Ryan',
  'Katerina',
  'Aiden',
  'Eldric Sage',
  'Mia',
  'Mochi',
  'Bellona',
  'Vincent',
  'Bunny',
  'Neil',
  'Elias',
  'Arthur',
  'Nini',
  'Ebona',
  'Seren',
  'Pip',
  'Stella',
  'Bodega',
  'Sonrisa',
  'Alek',
  'Dolce',
  'Sohee',
  'Ono Anna',
  'Lenn',
  'Emilien',
  'Andre',
  'Radio Gol',
  'Jada',
  'Dylan',
  'Li',
  'Marcus',
  'Roy',
  'Peter',
  'Sunny',
  'Eric',
  'Rocky',
  'Kiki',
];
const OMNI_3_ORIGINAL: readonly string[] = [
  'Cherry',
  'Ethan',
  'Nofish',
  'Jennifer',
  'Ryan',
  'Katerina',
  'Elias',
  'Jada',
  'Dylan',
  'Sunny',
  'Li',
  'Marcus',
  'Roy',
  'Peter',
  'Rocky',
  'Kiki',
  'Eric',
];
const OMNI_TURBO: readonly string[] = ['Cherry', 'Serena', 'Ethan', 'Chelsie'];

export function isVoiceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value)
  );
}

export function voiceCatalog(model: string): {
  presets: readonly string[];
  defaultVoice: string;
  custom: LiveVoiceState['custom'];
} {
  if (/^qwen3\.8-omni-flash-realtime(?:-\d{4}-\d{2}-\d{2})?$/u.test(model))
    // The 3.8 voice page links cloning, but enrollment's target-model list
    // currently only names 3.5. Allow manual IDs with an explicit warning.
    return { presets: OMNI_38, defaultVoice: 'Tina', custom: 'unverified' };
  if (
    /^qwen3\.5-omni-(?:plus|flash)-realtime(?:-\d{4}-\d{2}-\d{2})?$/u.test(
      model,
    )
  )
    return { presets: OMNI_35, defaultVoice: 'Tina', custom: 'supported' };
  if (
    model === 'qwen3-omni-flash-realtime' ||
    model === 'qwen3-omni-flash-realtime-2025-09-15'
  )
    return {
      presets: OMNI_3_ORIGINAL,
      defaultVoice: 'Cherry',
      custom: 'unsupported',
    };
  if (model === 'qwen3-omni-flash-realtime-2025-12-01')
    return { presets: OMNI_3, defaultVoice: 'Cherry', custom: 'unsupported' };
  if (/^qwen-omni-turbo-realtime(?:-\d{4}-\d{2}-\d{2})?$/u.test(model))
    return {
      presets: OMNI_TURBO,
      defaultVoice: 'Chelsie',
      custom: 'unsupported',
    };
  return { presets: [], defaultVoice: 'Tina', custom: 'unverified' };
}

const knownPresets = new Set([
  ...OMNI_38,
  ...OMNI_35,
  ...OMNI_3,
  ...OMNI_TURBO,
]);

export function getVoiceState(
  model: string,
  voice: string,
  overridden = false,
): LiveVoiceState {
  const { presets, custom } = voiceCatalog(model);
  const availability = presets.includes(voice)
    ? 'supported'
    : presets.length && (knownPresets.has(voice) || custom === 'unsupported')
      ? 'unsupported'
      : 'unverified';
  return {
    model,
    voice,
    presets: [...presets],
    custom,
    availability,
    overridden,
  };
}
