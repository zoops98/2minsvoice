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
import { makeLectureWav, PCM_BYTES_PER_SECOND } from './lecture-audio';
import { generateStyledLecture, STYLE_LABELS, type LectureStyle, type LectureLength } from './lecture-styles';
import { generateSyncedSrt } from './lecture-subtitles';

type FileType = 'image' | 'markdown' | 'html' | null;

const WAVE_BARS = [7, 14, 22, 13, 28, 46, 62, 42, 30, 45, 72, 91, 64, 46, 30, 21, 39, 57, 72, 49, 26, 36, 22, 11, 18, 9];

export default function App() {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('zoops_gemini_api_key') || '');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [draftApiKey, setDraftApiKey] = useState('');
  const settingsRef = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileType, setFileType] = useState<FileType>(null);
  const [lectureLength, setLectureLength] = useState<LectureLength>(2);
  const [chosenStyle, setChosenStyle] = useState<LectureStyle | null>(null);
  const lectureStyle = chosenStyle ?? (fileType === 'html' ? 'notes' : 'podcast');
  const [status, setStatus] = useState<'idle' | 'analyzing' | 'generating_audio' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [script, setScript] = useState<string>('');
  const [srtContent, setSrtContent] = useState<string>('');
  const [subtitleError, setSubtitleError] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [audioProgress, setAudioProgress] = useState('');
  const [audioDuration, setAudioDuration] = useState(0);
  const [resultSettings, setResultSettings] = useState({ minutes: lectureLength, style: lectureStyle });
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
      } else if (selectedFile.name.toLowerCase().endsWith('.md') || selectedFile.type === 'text/markdown') {
        setFileType('markdown');
      } else if (selectedFile.name.toLowerCase().endsWith('.html') || selectedFile.type === 'text/html') {
        setFileType('html');
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
    setSubtitleError('');
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

      const { script: generatedScript, audioParts } = await generateStyledLecture(
        ai, apiKey, contentPart, lectureStyle, lectureLength, setAudioProgress,
      );
      setScript(generatedScript);
      setStatus('generating_audio');
      const audioBytes = audioParts.reduce((sum, part) => sum + part.byteLength, 0);
      setAudioDuration(audioBytes / PCM_BYTES_PER_SECOND);

      try {
        const captions = await generateSyncedSrt(apiKey, audioParts, setAudioProgress);
        setSrtContent(captions.srt);
        if (captions.missedSpans) {
          setSubtitleError(`자막에서 발화가 빠졌을 수 있는 구간이 ${captions.missedSpans}곳 있습니다. 영상에 사용하기 전에 확인해 주세요.`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '음성 인식에 실패했습니다.';
        setSubtitleError(`${message} 음성과 대본은 저장할 수 있습니다.`);
      }

      const blob = new Blob([makeLectureWav(audioParts)], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      setResultSettings({ minutes: lectureLength, style: lectureStyle });
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
            <p>영어 지문과 필기 자료로 수업에 쓸 강의 음성, 대본, 자막을 만듭니다.</p>
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
                {([
                  ['notes', '필기 순서대로 문장과 표시를 짚어요'],
                  ['overview', '글 전체의 주제와 흐름을 풀어요'],
                  ['podcast', '학생과 선생님이 대화해요'],
                ] as const).map(([style, description]) => (
                  <label className="cs-choice" key={style}>
                    <input type="radio" name="mode" value={style} checked={lectureStyle === style}
                      onClick={() => setChosenStyle(style)} onChange={() => setChosenStyle(style)} />
                    <strong>{STYLE_LABELS[style]}</strong><small>{description}</small>
                  </label>
                ))}
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
            {lectureStyle === 'overview' && lectureLength >= 10 && (
              <p className="cs-plan">주제 → 핵심 문장과 구문 → 어휘와 해석 → 요약</p>
            )}
            <button className="cs-run" type="submit" disabled={isGenerating}>
              {isGenerating ? <Loader2 className="cs-spinner" aria-hidden="true" /> : null}
              <span aria-live="polite">{isGenerating ? (audioProgress || '자료 분석 중…') : `${lectureLength}분 강의 만들기`}</span>
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
                {STYLE_LABELS[resultSettings.style]}
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
                      <span className="text-sm">음성 기반 자막 저장</span>
                    </button>
                  </div>
                </div>
              {subtitleError && <p className="cs-inline-error" role="status">{subtitleError}</p>}
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
        <footer className="cs-footer"><strong>ZoopsBooks</strong><span>WAV 음성 · TXT 대본 · SRT 자막</span></footer>
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
