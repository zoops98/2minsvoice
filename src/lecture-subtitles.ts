import { makeLectureWav, PCM_BYTES_PER_SECOND } from './lecture-audio';

type TimedWord = { text: string; start: number; end: number };
type TranscriptResponse = {
  status?: string;
  steps?: { type: string; content?: { annotations?: {
    type: string; text?: string; start_offset?: string; end_offset?: string;
  }[] }[] }[];
};

const MAX_AUDIO_BYTES = 120 * PCM_BYTES_PER_SECOND;
const LINE_WIDTH = 24;
const RECHECK_GAP_SECONDS = 1.8;
class TimestampError extends Error {}

function formatTime(seconds: number) {
  const ms = Math.round(seconds * 1000);
  const pair = (value: number) => String(value).padStart(2, '0');
  return `${pair(Math.floor(ms / 3600000))}:${pair(Math.floor(ms / 60000) % 60)}:${pair(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`;
}

function wordOffset(value?: string) {
  return value && /^\d+(?:\.\d+)?s$/.test(value) ? Number(value.slice(0, -1)) : NaN;
}

function readWords(result: TranscriptResponse, duration: number): TimedWord[] {
  const words: TimedWord[] = [];
  let invalid = 0;
  for (const step of result.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const part of step.content ?? []) {
      for (const annotation of part.annotations ?? []) {
        if (annotation.type !== 'word_info') continue;
        const text = annotation.text?.trim().replace(/[\r\n]/g, ' ');
        const start = wordOffset(annotation.start_offset);
        const end = wordOffset(annotation.end_offset);
        const previous = words.at(-1);
        if (!text || !Number.isFinite(start) || !Number.isFinite(end)
          || start >= duration || end <= start || end > duration + 0.5
          || (previous && start < previous.start)) {
          invalid++;
          continue;
        }
        words.push({ text, start, end: Math.min(end, duration) });
      }
    }
  }
  if (!words.length || invalid > Math.max(8, words.length * 0.20)) {
    throw new TimestampError('음성 인식 결과에 자막 시간 정보가 부족합니다.');
  }
  return words;
}

function makeCues(words: TimedWord[]) {
  const cues: { start: number; end: number; lines: string[] }[] = [];
  let lines: string[] = [];
  let start = 0;
  let end = 0;
  const flush = () => {
    if (lines.length) cues.push({ start, end, lines });
    lines = [];
  };
  for (const word of words) {
    const lastLine = lines.at(-1) ?? '';
    const append = lastLine ? `${lastLine} ${word.text}` : word.text;
    const sentenceEnded = /[.!?。！？]["'”’)]*$/.test(lastLine);
    if (lines.length && (
      word.start - end > 0.65
      || word.end - start > 5.5
      || (sentenceEnded && end - start >= 1)
      || (lines.length === 2 && append.length > LINE_WIDTH)
    )) flush();

    if (!lines.length) {
      start = word.start;
      lines.push(word.text);
    } else if (append.length > LINE_WIDTH) {
      lines.push(word.text);
    } else {
      lines[lines.length - 1] = append;
    }
    end = Math.max(end, word.end);
  }
  flush();
  return cues;
}

async function transcribe(apiKey: string, pcm: Uint8Array[], duration: number) {
  const wave = makeLectureWav(pcm);
  const chunks: string[] = [];
  for (let index = 0; index < wave.length; index += 8192) {
    chunks.push(String.fromCharCode(...wave.subarray(index, index + 8192)));
  }
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model: 'gemini-3.5-transcribe',
      store: false,
      input: [{ type: 'audio', mime_type: 'audio/wav', data: btoa(chunks.join('')) }],
      generation_config: {
        transcription_config: { mode: { type: 'verbatim', timestamp_granularities: ['word'] } },
      },
    }),
  });
  if (!response.ok) throw new Error(`음성 인식 요청 실패 (HTTP ${response.status})`);
  const result: TranscriptResponse = await response.json();
  if (result.status !== 'completed') throw new Error('음성 인식을 완료하지 못했습니다.');
  return readWords(result, duration);
}

function samplesBetween(pcm: Uint8Array, start: number, end: number) {
  const byteAt = (seconds: number) => Math.round(seconds * PCM_BYTES_PER_SECOND / 2) * 2;
  return pcm.subarray(byteAt(start), byteAt(end));
}

function hasSpeech(pcm: Uint8Array, start: number, end: number, minimumActiveSeconds = 0.36) {
  const slice = samplesBetween(pcm, start, end);
  const samples = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
  const frameBytes = PCM_BYTES_PER_SECOND / 50;
  let active = 0;
  const frames = Math.floor(samples.byteLength / frameBytes);
  for (let frame = 0; frame < frames; frame++) {
    const first = frame * frameBytes;
    let power = 0;
    // An RMS estimate on one sample in four is sufficient for finding voiced gaps.
    for (let i = first; i < first + frameBytes; i += 8) {
      const value = samples.getInt16(i, true);
      power += value * value;
    }
    if (Math.sqrt(power / (frameBytes / 8)) >= 400) active++;
  }
  return active >= Math.max(Math.ceil(minimumActiveSeconds * 50), frames * 0.22);
}

function spokenGaps(words: TimedWord[], pcm: Uint8Array) {
  const gaps: { start: number; end: number }[] = [];
  let lastEnd = 0;
  const check = (end: number) => {
    if (end - lastEnd >= RECHECK_GAP_SECONDS && hasSpeech(pcm, lastEnd, end)) {
      gaps.push({ start: lastEnd, end });
    }
  };
  for (const word of words) {
    check(word.start);
    lastEnd = Math.max(lastEnd, word.end);
  }
  check(pcm.length / PCM_BYTES_PER_SECOND);
  return gaps;
}

function quietSplit(pcm: Uint8Array, approximate: number) {
  for (const offset of [0, -0.2, 0.2, -0.4, 0.4, -0.6, 0.6, -0.8, 0.8]) {
    const point = approximate + offset;
    if (point >= 0.1 && point + 0.1 < pcm.byteLength / PCM_BYTES_PER_SECOND
      && !hasSpeech(pcm, point - 0.06, point + 0.06, 0.02)) return point;
  }
  return approximate;
}

async function transcribeWithSplit(apiKey: string, pcm: Uint8Array, depth = 0): Promise<TimedWord[]> {
  const duration = pcm.length / PCM_BYTES_PER_SECOND;
  try {
    return await transcribe(apiKey, [pcm], duration);
  } catch (error) {
    if (!(error instanceof TimestampError)) throw error;
    if (duration < 8 || depth >= 2) return [];
    const split = quietSplit(pcm, duration / 2);
    const first = samplesBetween(pcm, 0, split);
    const offset = first.byteLength / PCM_BYTES_PER_SECOND;
    const left = await transcribeWithSplit(apiKey, first, depth + 1);
    const right = await transcribeWithSplit(apiKey, pcm.subarray(first.byteLength), depth + 1);
    return [...left, ...right.map(word => ({ ...word, start: word.start + offset, end: word.end + offset }))];
  }
}

async function recoverMissingSpeech(apiKey: string, words: TimedWord[], pcm: Uint8Array, onRetry: () => void) {
  const recovered: TimedWord[] = [];
  const paddingSeconds = 0.25;
  const pad = new Uint8Array(paddingSeconds * PCM_BYTES_PER_SECOND);
  const clips: { start: number; end: number }[] = [];
  for (const gap of spokenGaps(words, pcm)) {
    let start = gap.start;
    while (gap.end - start > 22) {
      const end = quietSplit(pcm, start + 20);
      clips.push({ start, end });
      start = end;
    }
    clips.push({ start, end: gap.end });
  }
  for (const gap of clips.slice(0, 12)) {
    onRetry();
    const clip = samplesBetween(pcm, gap.start, gap.end);
    try {
      const reply = await transcribe(apiKey, [pad, clip, pad], clip.length / PCM_BYTES_PER_SECOND + 2 * paddingSeconds);
      const offset = gap.start - paddingSeconds;
      for (const word of reply) {
        const start = Math.max(gap.start, word.start + offset);
        const end = Math.min(gap.end, word.end + offset);
        if (end > start) recovered.push({ ...word, start, end });
      }
    } catch {
      // Keep the aligned captions from neighboring speech. Unresolved gaps are reported below.
    }
  }
  const combined = [...words, ...recovered].sort((a, b) => a.start - b.start);
  return { words: combined, missedSpans: spokenGaps(combined, pcm).length };
}

export async function generateSyncedSrt(
  apiKey: string,
  audioParts: Uint8Array[],
  onProgress: (message: string) => void,
) {
  const batches: { parts: Uint8Array[]; bytes: number }[] = [];
  for (const part of audioParts) {
    let batch = batches.at(-1);
    if (!batch || batch.bytes + part.byteLength > MAX_AUDIO_BYTES) {
      batch = { parts: [], bytes: 0 };
      batches.push(batch);
    }
    batch.parts.push(part);
    batch.bytes += part.byteLength;
  }

  const cues: ReturnType<typeof makeCues> = [];
  let offsetBytes = 0;
  let missedSpans = 0;
  for (const [index, batch] of batches.entries()) {
    onProgress(`음성과 자막 맞추는 중… (${index + 1}/${batches.length})`);
    const pcm = makeLectureWav(batch.parts).subarray(44);
    const words = await transcribeWithSplit(apiKey, pcm);
    const recovered = await recoverMissingSpeech(apiKey, words, pcm, () => {
      onProgress(`자막이 빠진 발화 다시 확인 중… (${index + 1}/${batches.length})`);
    });
    const offset = offsetBytes / PCM_BYTES_PER_SECOND;
    for (const cue of makeCues(recovered.words)) {
      cues.push({ ...cue, start: cue.start + offset, end: cue.end + offset });
    }
    missedSpans += recovered.missedSpans;
    offsetBytes += batch.bytes;
  }

  const blocks: string[] = [];
  for (const [index, cue] of cues.entries()) {
    const nextStart = cues[index + 1]?.start ?? offsetBytes / PCM_BYTES_PER_SECOND;
    const end = Math.min(cue.end, nextStart);
    if (Math.round(end * 1000) <= Math.round(cue.start * 1000)) continue;
    blocks.push(`${blocks.length + 1}\r\n${formatTime(cue.start)} --> ${formatTime(end)}\r\n${cue.lines.join('\r\n')}`);
  }
  if (!blocks.length) throw new Error('유효한 자막을 만들지 못했습니다.');
  return { srt: blocks.join('\r\n\r\n') + '\r\n', missedSpans };
}
