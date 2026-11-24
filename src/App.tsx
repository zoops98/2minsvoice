/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import { 
  Upload, 
  FileText, 
  Play, 
  Pause, 
  Loader2, 
  Settings, 
  CheckCircle2, 
  AlertCircle,
  Download,
  FileDown,
  Volume2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { generateLectureAudio, PCM_BYTES_PER_SECOND, prepareLecture } from './lecture-audio';
import { generateLongSoloLecture } from './long-solo-lecture';

type FileType = 'image' | 'markdown' | 'html' | null;
type LectureMode = 'podcast' | 'solo';
type LectureLength = 2 | 3 | 5 | 10 | 15;

const WAVE_BARS = [7, 14, 22, 13, 28, 46, 62, 42, 30, 45, 72, 91, 64, 46, 30, 21, 39, 57, 72, 49, 26, 36, 22, 11, 18, 9];

export default function App() {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('zoops_gemini_api_key') || '');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [draftApiKey, setDraftApiKey] = useState('');
  const settingsRef = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileType, setFileType] = useState<FileType>(null);
  const [lectureLength, setLectureLength] = useState<LectureLength>(2);
  const [lectureMode, setLectureMode] = useState<LectureMode>('podcast');
  const [status, setStatus] = useState<'idle' | 'analyzing' | 'generating_audio' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [script, setScript] = useState<string>('');
  const [srtContent, setSrtContent] = useState<string>('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [audioProgress, setAudioProgress] = useState('');
  const [audioDuration, setAudioDuration] = useState(0);
  const [resultSettings, setResultSettings] = useState({ minutes: lectureLength, mode: lectureMode });
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (apiKey) {
      localStorage.setItem('zoops_gemini_api_key', apiKey);
    }
  }, [apiKey]);

  useEffect(() => {
    const dialog = settingsRef.current;
    if (isSettingsOpen && !dialog?.open) {
      setDraftApiKey(apiKey);
      dialog?.showModal();
    } else if (!isSettingsOpen && dialog?.open) {
      dialog.close();
    }
  }, [isSettingsOpen, apiKey]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setErrorMessage('');
      if (status === 'error') setStatus('idle');
      setFile(selectedFile);
      if (selectedFile.type.startsWith('image/')) {
        setFileType('image');
      } else if (selectedFile.name.endsWith('.md') || selectedFile.type === 'text/markdown') {
        setFileType('markdown');
      } else if (selectedFile.name.endsWith('.html') || selectedFile.type === 'text/html') {
        setFileType('html');
        // Auto-switch to solo mode if HTML is uploaded as it's likely a mock exam note
        setLectureMode('solo');
      } else {
        setFile(null);
        e.target.value = '';
        setFileType(null);
        setErrorMessage('이미지, 마크다운 또는 HTML 파일만 지원합니다.');
      }
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve(base64);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsText(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });
  };

  const generateLecture = async () => {
    if (!apiKey) {
      setIsSettingsOpen(true);
      return;
    }
    if (!file || !fileType) {
      setErrorMessage('파일을 먼저 업로드해주세요.');
      return;
    }

    setStatus('analyzing');
    setErrorMessage('');
    setAudioUrl(null);
    setScript('');
    setSrtContent('');
    setProgress(0);
    setAudioProgress('');

    try {
      const ai = new GoogleGenAI({ apiKey });
      
      // Step 1: Generate Script
      let contentPart;
      if (fileType === 'image') {
        const base64 = await fileToBase64(file);
        contentPart = {
          inlineData: {
            mimeType: file.type,
            data: base64
          }
        };
      } else {
        const text = await readFileAsText(file);
        contentPart = { text };
      }

      const getTargetChars = (len: LectureLength, mode: LectureMode) => {
        if (mode === 'solo') {
          if (len === 2) return '약 700자';
          if (len === 3) return '약 1100자';
          return `약 ${len * 360}자`;
        } else {
          if (len === 2) return '약 600자';
          if (len === 3) return '약 950자';
          return `약 ${len * 300}자`;
        }
      };

      const scriptPrompt = lectureMode === 'podcast' ? `
        당신은 전문 교육 팟캐스트 작가입니다. 
        업로드된 내용을 바탕으로 학생과 선생님이 대화하는 ${lectureLength}분 분량의 교육용 스크립트를 작성하세요.
        
        규칙:
        1. 각 발화는 새 줄에 '학생: [대사]' 또는 '선생님: [대사]'로 작성하세요. 화자 이름, 별명, 무대 지시, 제목은 넣지 마세요.
        2. 학생은 궁금한 점을 짧고 자연스럽게 질문하고, 선생님은 명확하게 설명합니다. 대사 안에서도 학생을 이름이나 별명으로 부르지 마세요.
        3. 청취자가 쉽게 이해할 수 있도록 핵심 내용을 대화로 풀어내세요.
        4. ${getTargetChars(lectureLength, 'podcast')} 정도의 분량으로 작성하세요.
        5. 한국어로 작성하세요.
        6. 첫 대사는 반드시 '선생님: 강의 시작하겠습니다.'로 시작하고 인사, 자기소개, 잡담 없이 바로 본론으로 들어가세요. 이후에는 도입 인사를 반복하지 마세요.
      ` : `
        당신은 전문 수능/내신 영어 강사입니다. 
        업로드된 필기 데이터(HTML/텍스트)를 바탕으로, 학생들에게 핵심 내용을 짚어주는 1인 강의 대본을 작성하세요.

        규칙:
        1. 각 발화는 새 줄에 '선생님: [대사]'로 작성하세요. 다른 인물, 이름, 별명, 무대 지시, 제목은 넣지 마세요.
        2. 선생님은 친절하지만 핵심을 정확히 찌르는 명쾌한 어조를 사용합니다.
        3. 자료 내의 구문 분석, 문법 포인트, 주제 및 요약 내용을 빠짐없이 설명에 녹여내세요.
        4. 청취자가 필기 노트를 보고 있다고 가정하고 시각적인 설명(예: "여기 파란색 박스의 핵심 내용을 보시면...")을 곁들이세요.
        5. 분량은 약 ${lectureLength}분 (${getTargetChars(lectureLength, 'solo')})에 해당하도록 한국어로 작성하세요.
        6. 설명이 너무 빠르지 않게, 전문 강사처럼 문장 사이사이에 여유를 두고 차근차근 설명하는 어조로 작성하세요.
        7. 첫 대사는 반드시 '선생님: 강의 시작하겠습니다.'로 시작하고 인사, 자기소개, 잡담 없이 바로 본론으로 들어가세요. 이후에는 도입 인사를 반복하지 마세요.
      `;

      const longSolo = lectureMode === 'solo' && (lectureLength === 10 || lectureLength === 15);
      if (longSolo) setStatus('generating_audio');
      const lecture = longSolo
        ? { ...await generateLongSoloLecture(ai, apiKey, contentPart, lectureLength, setAudioProgress), dialogue: [] }
        : {
            ...prepareLecture((await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: [{ parts: [{ text: scriptPrompt }, contentPart] }],
            })).text, lectureMode),
            sections: [],
            audioParts: null,
          };

      setScript(lecture.script);

      // Step 2: Generate SRT Subtitles
      let sectionEnd = 0;
      const sectionTimes = lecture.sections.map(({ title, seconds }) => {
        const start = sectionEnd;
        sectionEnd += seconds;
        return `${title}: ${start.toFixed(2)}초부터 ${sectionEnd.toFixed(2)}초까지`;
      });
      const srtPrompt = `
        다음 스크립트를 바탕으로 음성과 정확히 일치하는 .srt 형식의 자막 파일을 생성하세요.
        
        규칙:
        1. ${longSolo
          ? `실제 음성의 총 길이는 ${sectionEnd.toFixed(2)}초입니다. 아래 구간 시간을 벗어나지 않도록 자막을 배분하세요.\n${sectionTimes.join('\n')}`
          : `총 길이는 약 ${lectureLength}분 (${lectureLength * 60}초) 내외입니다.`}
        2. **중요: 각 자막 블록은 반드시 최대 2줄 이내이어야 합니다.** 한 블록에 내용이 많으면 여러 블록으로 나누세요.
        3. 한국어 일반적인 말하기 속도(1초당 약 3.5자)를 고려하여 시작(00:00:00,000)부터 끝까지 빈틈없이 시간을 배분하세요.
        4. 문장이 끝나지 않았더라도 자막이 너무 길어지면(한 줄에 약 20자 내외) 적절히 끊어서 다음 블록으로 넘기세요.
        5. '학생:', '선생님:' 같은 화자 표시와 대괄호 안의 구간 제목은 자막에서 제외하고 실제 대사 내용만 담으세요.
        
        스크립트:
        ${lecture.script}
        
        출력 형식: 오직 .srt 파일 내용(순번, 시간대, 텍스트)만 출력하세요.
      `;

      if (longSolo) setAudioProgress('예상 자막 작성 중…');
      try {
        const srtResponse = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [{ parts: [{ text: srtPrompt }] }],
        });
        if (srtResponse.text) setSrtContent(srtResponse.text);
      } catch (error) {
        if (!longSolo) throw error;
        // Keep the completed audio and script if optional subtitles fail.
        console.warn('예상 자막 생성 실패', error);
      }

      setStatus('generating_audio');

      const audioParts = lecture.audioParts ?? await generateLectureAudio(apiKey, lecture.dialogue, (current, total) => {
        setAudioProgress(`음성 생성 중… (${current}/${total})`);
      });
      const totalBytes = audioParts.reduce((sum, part) => sum + part.length, 0);
      const bytes = new Uint8Array(totalBytes);
      let byteOffset = 0;
      for (const part of audioParts) {
        bytes.set(part, byteOffset);
        byteOffset += part.length;
      }
      setAudioDuration(totalBytes / PCM_BYTES_PER_SECOND);

      // Wrap the combined 24 kHz mono PCM samples in one WAV header.
      const wavHeader = new ArrayBuffer(44);
      const view = new DataView(wavHeader);

      // RIFF identifier
      view.setUint32(0, 0x52494646, false); // "RIFF"
      // file length
      view.setUint32(4, 36 + bytes.length, true);
      // RIFF type
      view.setUint32(8, 0x57415645, false); // "WAVE"
      // format chunk identifier
      view.setUint32(12, 0x666d7420, false); // "fmt "
      // format chunk length
      view.setUint32(16, 16, true);
      // sample format (raw PCM)
      view.setUint16(20, 1, true);
      // channel count
      view.setUint16(22, 1, true);
      // sample rate
      view.setUint32(24, 24000, true);
      // byte rate (sample rate * block align)
      view.setUint32(28, 24000 * 2, true);
      // block align (channel count * bytes per sample)
      view.setUint16(32, 2, true);
      // bits per sample
      view.setUint16(34, 16, true);
      // data chunk identifier
      view.setUint32(36, 0x64617461, false); // "data"
      // data chunk length
      view.setUint32(40, bytes.length, true);

      const blob = new Blob([wavHeader, bytes], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      setResultSettings({ minutes: lectureLength, mode: lectureMode });
      setStatus('success');
    } catch (error: any) {
      console.error(error);
      setStatus('error');
      setErrorMessage(error.message || '알 수 없는 오류가 발생했습니다.');
    }
  };

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      const current = audioRef.current.currentTime;
      const duration = audioRef.current.duration;
      if (duration > 0) {
        setProgress((current / duration) * 100);
      }
    }
  };

  const downloadAudio = () => {
    if (audioUrl) {
      const a = document.createElement('a');
      a.href = audioUrl;
      a.download = `lecture_${resultSettings.minutes}min_${Date.now()}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const downloadScript = () => {
    if (script) {
      const blob = new Blob([script], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `script_${resultSettings.minutes}min_${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const downloadSRT = () => {
    if (srtContent) {
      const blob = new Blob([srtContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `subtitles_${resultSettings.minutes}min_${Date.now()}.srt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const isGenerating = status === 'analyzing' || status === 'generating_audio';

  return (
    <div className="cs-app">
      <header className="cs-header">
        <div className="cs-shell cs-nav">
          <div className="cs-brand">
            <span className="cs-mark" aria-hidden="true">
              {[9, 16, 22, 14, 8].map(height => <b key={height} style={{ height }} />)}
            </span>
            <strong>2분강의</strong>
          </div>
          <button type="button" className="cs-api" onClick={() => setIsSettingsOpen(true)} disabled={isGenerating}>
            <Settings aria-hidden="true" /> API 설정
          </button>
        </div>
      </header>

      <main className="cs-shell">
        <section className="cs-hero" aria-labelledby="cs-hero-title">
          <div>
            <div className="cs-owner">C&amp;S 전용</div>
            <h1 id="cs-hero-title">영어 지문을<br /><span>듣는 강의로.</span></h1>
            <p>영어 지문과 필기 자료로 수업에 쓸 강의 음성, 대본, 예상 자막을 만듭니다.</p>
          </div>
          <div className="cs-art" aria-hidden="true">
            <div className="cs-paper"><span /><span /><span /></div>
            <div className="cs-wave">
              {WAVE_BARS.map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}
            </div>
          </div>
        </section>

        <div className="cs-workspace">
          <section className="cs-panel" aria-labelledby="cs-source-title">
            <h2 id="cs-source-title">학습 자료</h2>
            <p className="cs-lede">강의에 사용할 지문이나 필기 파일을 올려 주세요.</p>
            <label className="cs-upload">
              <span className="cs-upload-icon">
                {fileType ? <CheckCircle2 aria-hidden="true" /> : <Upload aria-hidden="true" />}
              </span>
              <strong>{file?.name || '파일 선택'}</strong>
              <span className="cs-quiet" id="cs-file-types">이미지, HTML, 마크다운</span>
              <input
                type="file"
                accept="image/*,.html,.md,text/html,text/markdown"
                aria-label="학습 자료 파일 선택"
                aria-describedby="cs-file-types"
                onChange={handleFileChange}
                disabled={isGenerating}
              />
            </label>
            {status !== 'error' && errorMessage && <p className="cs-inline-error" role="alert">{errorMessage}</p>}
          </section>

          <form className="cs-panel cs-setup" aria-labelledby="cs-config-title" onSubmit={event => {
            event.preventDefault();
            if (!isGenerating) void generateLecture();
          }}>
            <h2 id="cs-config-title">강의 설정</h2>
            <fieldset className="cs-field" disabled={isGenerating}>
              <legend>강의 방식</legend>
              <div className="cs-mode-list">
                <label className="cs-choice">
                  <input type="radio" name="mode" value="podcast" checked={lectureMode === 'podcast'} onChange={() => setLectureMode('podcast')} />
                  <strong>대화형 팟캐스트</strong><small>학생과 선생님의 대화</small>
                </label>
                <label className="cs-choice">
                  <input type="radio" name="mode" value="solo" checked={lectureMode === 'solo'} onChange={() => setLectureMode('solo')} />
                  <strong>필기 집중 강의</strong><small>선생님의 1인 설명</small>
                </label>
              </div>
            </fieldset>
            <fieldset className="cs-field" disabled={isGenerating}>
              <legend>목표 시간</legend>
              <div className="cs-durations">
                {([2, 3, 5, 10, 15] as const).map(minutes => (
                  <label className="cs-length" key={minutes}>
                    <input type="radio" name="minutes" value={minutes} checked={lectureLength === minutes} onChange={() => setLectureLength(minutes)} />
                    {minutes}분
                  </label>
                ))}
              </div>
            </fieldset>
            {lectureMode === 'solo' && lectureLength >= 10 && (
              <p className="cs-plan">주제 → 핵심 문장과 구문 → 어휘와 해석 → 요약</p>
            )}
            <button className="cs-run" type="submit" disabled={isGenerating}>
              {isGenerating ? <Loader2 className="cs-spinner" aria-hidden="true" /> : null}
              <span role="status">{isGenerating ? (audioProgress || '자료 분석 중…') : `${lectureLength}분 강의 만들기`}</span>
              {!isGenerating && <span aria-hidden="true">→</span>}
            </button>
          </form>
        </div>

        {/* Status & Audio Player */}
        <div className="cs-outcome">
        <AnimatePresence>
          {status === 'success' && audioUrl && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.98, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="bg-violet-50/40 backdrop-blur-sm border border-violet-100/50 rounded-[24px] p-4 sm:p-8 flex flex-col items-center text-center shadow-inner"
            >
              <div className="w-24 h-24 bg-violet-600 rounded-[32px] flex items-center justify-center mb-8 shadow-xl shadow-violet-200 rotate-3">
                <CheckCircle2 className="w-12 h-12 text-white -rotate-3" />
              </div>
              <h3 className="text-4xl font-serif font-bold text-violet-900 mb-4 tracking-tight">강의가 완성되었습니다!</h3>
              <p className="text-violet-700/70 font-serif italic text-xl mb-12 max-w-sm mx-auto">
                {resultSettings.mode === 'podcast' ? '학생과 선생님의 대화형 강의를 들어보세요.' : '필기 핵심 내용을 짚어주는 1인 집중 강의입니다.'}
              </p>
              
              <div className="w-full bg-white rounded-[24px] p-4 sm:p-8 flex flex-col gap-10 shadow-xl shadow-gray-200/50 border border-violet-50">
                <div className="flex flex-col items-center gap-8">
                  <button 
                    onClick={togglePlay}
                    aria-label={isPlaying ? '일시 정지' : '재생'}
                    className="group relative w-24 h-24 flex items-center justify-center transition-all active:scale-95"
                  >
                    <div className="absolute inset-0 bg-violet-600 rounded-full shadow-lg group-hover:scale-105 transition-transform" />
                    <div className="relative z-10 text-white">
                      {isPlaying ? <Pause className="w-10 h-10" /> : <Play className="w-10 h-10 ml-2 shadow-sm" />}
                    </div>
                  </button>
                  
                  <div className="w-full text-center">
                    <div className="flex flex-col items-center gap-2 mb-6">
                      <div className="flex items-center gap-2 px-3 py-1 bg-violet-50 rounded-full">
                        <Volume2 className="w-3 h-3 text-violet-600" />
                        <span className="text-[10px] font-bold text-violet-700 uppercase tracking-widest">
                          목표 {resultSettings.minutes}분 · 실제 {Math.floor(audioDuration / 60)}분 {Math.floor(audioDuration % 60)}초
                        </span>
                      </div>
                      <h4 className="text-lg font-serif font-bold text-gray-800">강의 리플레이</h4>
                    </div>
                    
                    <div className="relative h-2 w-full bg-gray-100 rounded-full overflow-hidden mb-2 group cursor-pointer">
                      <div 
                        className="h-full bg-violet-500 rounded-full transition-all duration-100 ease-linear relative"
                        style={{ width: `${progress}%` }}
                      >
                        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-violet-600 rounded-full shadow-md scale-0 group-hover:scale-100 transition-transform" />
                      </div>
                    </div>
                    <div className="flex justify-between px-1">
                      <span className="text-[10px] font-mono text-gray-400">0:00</span>
                      <span className="text-[10px] font-mono text-gray-400">{Math.floor(audioDuration / 60)}:{String(Math.floor(audioDuration % 60)).padStart(2, '0')}</span>
                    </div>
                  </div>
                </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <button 
                      onClick={downloadAudio}
                      className="flex flex-col items-center gap-2 py-4 bg-gray-50 hover:bg-violet-50 hover:text-violet-700 rounded-2xl text-gray-500 font-bold transition-all border border-transparent hover:border-violet-100"
                    >
                      <Download className="w-5 h-5" />
                      <span className="text-sm">음성 저장</span>
                    </button>
                    <button 
                      onClick={downloadScript}
                      className="flex flex-col items-center gap-2 py-4 bg-gray-50 hover:bg-violet-50 hover:text-violet-700 rounded-2xl text-gray-500 font-bold transition-all border border-transparent hover:border-violet-100"
                    >
                      <FileDown className="w-5 h-5" />
                      <span className="text-sm">대본 저장</span>
                    </button>
                    <button 
                      onClick={downloadSRT}
                      disabled={!srtContent}
                      className="flex flex-col items-center gap-2 py-4 bg-gray-50 hover:bg-violet-50 hover:text-violet-700 rounded-2xl text-gray-500 font-bold transition-all border border-transparent hover:border-violet-100 disabled:opacity-30 disabled:hover:bg-gray-50 disabled:hover:text-gray-500 disabled:hover:border-transparent"
                    >
                      <FileText className="w-5 h-5" />
                      <span className="text-sm">예상 자막 저장</span>
                    </button>
                  </div>
                </div>
              <audio 
                ref={audioRef} 
                src={audioUrl} 
                onEnded={() => {
                  setIsPlaying(false);
                  setProgress(0);
                }}
                onTimeUpdate={handleTimeUpdate}
                className="hidden"
              />
            </motion.div>
          )}

          {status === 'error' && (
            <motion.div 
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-red-50/50 border border-red-100 rounded-[40px] p-8 flex items-center gap-6"
            >
              <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center shrink-0">
                <AlertCircle className="w-7 h-7 text-red-600" />
              </div>
              <div>
                <p className="font-serif font-bold text-xl text-red-900">오류가 발생했습니다</p>
                <p className="text-sm text-red-700 font-medium">{errorMessage}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        </div>
        <footer className="cs-footer"><strong>ZoopsBooks</strong><span>WAV 음성 · TXT 대본 · SRT 예상 자막</span></footer>
      </main>

      <dialog className="cs-dialog" ref={settingsRef} aria-labelledby="cs-api-title" onClose={() => setIsSettingsOpen(false)}>
        <h2 id="cs-api-title">API 설정</h2>
        <p>강의 생성에 사용할 Gemini API 키를 입력해 주세요.</p>
        <form className="cs-key-form" onSubmit={event => {
          event.preventDefault();
          setApiKey(draftApiKey.trim());
          setIsSettingsOpen(false);
        }}>
          <label htmlFor="cs-api-key">Gemini API 키</label>
          <input id="cs-api-key" type="password" autoComplete="off" value={draftApiKey} onChange={event => setDraftApiKey(event.target.value)} required />
          <small>키는 이 브라우저에 저장됩니다.</small>
          <div className="cs-dialog-actions">
            <button type="button" className="cs-api" onClick={() => setIsSettingsOpen(false)}>닫기</button>
            <button type="submit" className="cs-run" disabled={!draftApiKey.trim()}>저장하기</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
