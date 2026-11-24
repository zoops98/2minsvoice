type LectureMode = 'podcast' | 'solo';
const VOICES = { 선생님: 'Aoede', 학생: 'Puck' } as const;
type Speaker = keyof typeof VOICES;
type Turn = { speaker: Speaker; text: string };
type SpeechResponse = {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { inlineData?: { data?: string } }[] };
  }[];
};

const SPEECH_MODEL = 'gemini-3.8-flash-lite-tts';
const SPEECH_STYLE = 'Natural standard Korean with clear pronunciation, steady volume and a comfortable pace. Keep the assigned speaker identity and vocal register throughout. Read English examples clearly without imitating other voices.';
export const LECTURE_OPENING = '강의 시작하겠습니다.';
export const PCM_BYTES_PER_SECOND = 24000 * 2;

export function makeLectureWav(parts: Uint8Array[]) {
  const pcmSize = parts.reduce((total, part) => total + part.byteLength, 0);
  const wav = new Uint8Array(44 + pcmSize);
  const view = new DataView(wav.buffer);
  view.setUint32(0, 0x52494646); // RIFF
  view.setUint32(4, 36 + pcmSize, true);
  view.setUint32(8, 0x57415645); // WAVE
  view.setUint32(12, 0x666d7420); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, PCM_BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461); // data
  view.setUint32(40, pcmSize, true);
  let offset = 44;
  for (const part of parts) {
    wav.set(part, offset);
    offset += part.byteLength;
  }
  return wav;
}
const MAX_CHARS = 700;
const STUDENT_PARTICLES: Record<string, string> = {
  가: '이', 를: '을', 는: '은', 와: '과', 야: '', 아: '',
};

export function prepareLecture(generated: string | undefined, mode: LectureMode) {
  const turns: Turn[] = [];
  const lines = (generated ?? '')
    .replace(/^\s*```[^\n]*\n|\n\s*```\s*$/g, '')
    .split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(?:[-*]\s+)?\*{0,2}(선생님|학생|쌤|줍스)\*{0,2}\s*[:：]\*{0,2}\s*(.*)$/);
    if (match) {
      const speaker = match[1] === '학생' || match[1] === '줍스' ? '학생' : '선생님';
      turns.push({ speaker, text: match[2] });
    } else if (turns.length && !/^[가-힣a-zA-Z]{1,12}\s*[:：]/.test(line)) {
      const previousTurn = turns[turns.length - 1];
      previousTurn.text = `${previousTurn.text} ${line}`.trim();
    } else {
      throw new Error('대본에서 화자를 구분할 수 없습니다. 다시 생성해 주세요.');
    }
  }

  // Normalize legacy names, including when the student is addressed in a line.
  const dialogue = turns.filter(turn => turn.text).map(turn => ({
    ...turn,
    text: turn.text.replace(/줍스([가는를와야아])?(?=[\s.,!?…:。！？]|$)|줍스/g, (_, particle) =>
      `학생${STUDENT_PARTICLES[particle] ?? ''}`),
  }));
  const first = dialogue[0];
  if (!first) throw new Error('음성으로 변환할 대본이 없습니다.');
  const hasStudent = dialogue.some(turn => turn.speaker === '학생');
  const hasTeacher = dialogue.some(turn => turn.speaker === '선생님');
  if (!hasTeacher || hasStudent !== (mode === 'podcast')) {
    throw new Error('선택한 강의 방식에 맞게 대본을 만들지 못했습니다. 다시 생성해 주세요.');
  }
  if (first.speaker !== '선생님' || !first.text.startsWith(LECTURE_OPENING)) {
    const remaining = first.text.replace(/^강의 시작하겠습니다[.!。]?\s*/, '');
    if (first.speaker === '선생님') {
      first.text = remaining ? `${LECTURE_OPENING} ${remaining}` : LECTURE_OPENING;
    } else {
      dialogue.unshift({ speaker: '선생님', text: LECTURE_OPENING });
    }
  }
  return {
    script: dialogue.map(turn => `${turn.speaker}: ${turn.text}`).join('\n'),
    dialogue,
  };
}

function splitLongTurn(turn: Turn): Turn[] {
  const chunks: Turn[] = [];
  let remaining = turn.text;
  while (remaining.length > MAX_CHARS) {
    const window = remaining.slice(0, MAX_CHARS + 1);
    const sentence = Array.from(window.matchAll(/[.!?。！？](?=\s)/g)).pop();
    const boundary = sentence ? (sentence.index ?? 0) + 1 : window.lastIndexOf(' ');
    const cut = boundary > 0 ? boundary : MAX_CHARS;
    chunks.push({ speaker: turn.speaker, text: remaining.slice(0, cut).trimEnd() });
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push({ speaker: turn.speaker, text: remaining });
  return chunks;
}

// Gemini 3.8 returns a WAV per request. Keep only the samples when joining clips.
function readWavSamples(encoded: string): Uint8Array {
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const invalidWav = 'Google이 지원하지 않는 WAV 형식의 음성을 반환했습니다.';

  if (bytes.length < 12 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) {
    throw new Error(invalidWav);
  }

  let hasExpectedFormat = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = view.getUint32(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > bytes.length) break;

    if (id === 0x666d7420 && size >= 16) { // fmt
      hasExpectedFormat = view.getUint16(start, true) === 1
        && view.getUint16(start + 2, true) === 1
        && view.getUint32(start + 4, true) === 24000
        && view.getUint16(start + 14, true) === 16;
    } else if (id === 0x64617461 && hasExpectedFormat && size > 0 && size % 2 === 0) { // data
      return bytes.subarray(start, start + size);
    }

    offset = start + size + (size % 2);
  }
  throw new Error(invalidWav);
}

export async function generateLectureAudio(
  apiKey: string,
  dialogue: Turn[],
  onProgress: (current: number, total: number) => void,
): Promise<Uint8Array[]> {
  const grouped: Turn[] = [];
  for (const turn of dialogue) {
    const previous = grouped[grouped.length - 1];
    if (previous?.speaker === turn.speaker) {
      previous.text += ` ${turn.text}`;
    } else {
      grouped.push({ ...turn });
    }
  }

  const chunks = grouped.flatMap(splitLongTurn);
  const audioParts: Uint8Array[] = [];
  for (const [index, { speaker, text }] of chunks.entries()) {
    onProgress(index + 1, chunks.length);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${SPEECH_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{
            text,
            speech_metadata: { style: SPEECH_STYLE },
          }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { voice: VOICES[speaker] } },
          },
        }),
      },
    );
    if (!response.ok) {
      const nextStep = response.status === 429
        ? 'API 사용 한도를 확인해 주세요.'
        : 'API 키와 프로젝트의 음성 모델 사용 권한을 확인해 주세요.';
      throw new Error(`${speaker} 음성(${index + 1}/${chunks.length}) 요청에 실패했습니다. (${response.status}) ${nextStep}`);
    }

    const result: SpeechResponse = await response.json();
    const candidate = result.candidates?.[0];
    const base64Audio = candidate?.content?.parts?.find(part => part.inlineData?.data)?.inlineData?.data;
    if (!base64Audio || (candidate?.finishReason && candidate.finishReason !== 'STOP')) {
      throw new Error(`${speaker} 음성(${index + 1}/${chunks.length})을 완성하지 못했습니다. 다시 시도해 주세요.`);
    }
    audioParts.push(readWavSamples(base64Audio));
  }
  return audioParts;
}
