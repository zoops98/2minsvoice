/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";
import { 
  Mic, 
  Upload, 
  FileText, 
  Image as ImageIcon, 
  Play, 
  Pause, 
  Loader2, 
  Settings, 
  CheckCircle2, 
  AlertCircle,
  Clock,
  Download,
  FileDown,
  Volume2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

type FileType = 'image' | 'markdown' | null;

export default function App() {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('zoops_gemini_api_key') || '');
  const [isSettingsOpen, setIsSettingsOpen] = useState(!apiKey);
  const [file, setFile] = useState<File | null>(null);
  const [fileType, setFileType] = useState<FileType>(null);
  const [lectureLength, setLectureLength] = useState<2 | 3>(2);
  const [status, setStatus] = useState<'idle' | 'analyzing' | 'generating_audio' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [script, setScript] = useState<string>('');
  const [srtContent, setSrtContent] = useState<string>('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (apiKey) {
      localStorage.setItem('zoops_gemini_api_key', apiKey);
    }
  }, [apiKey]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      if (selectedFile.type.startsWith('image/')) {
        setFileType('image');
      } else if (selectedFile.name.endsWith('.md') || selectedFile.type === 'text/markdown') {
        setFileType('markdown');
      } else {
        setFileType(null);
        setErrorMessage('이미지 또는 마크다운 파일만 지원합니다.');
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

      const scriptPrompt = `
        당신은 전문 교육 팟캐스트 작가입니다. 
        업로드된 내용을 바탕으로 '줍스(학생)'와 '쌤(선생님)'이 대화하는 ${lectureLength}분 분량의 교육용 스크립트를 작성하세요.
        
        규칙:
        1. 형식은 반드시 '줍스: [대사]', '쌤: [대사]' 형식을 반복해야 합니다.
        2. 줍스는 배우고자 하는 열의가 가득한 학생이며, 쌤은 명확하고 교육적으로 설명해주시는 여성 선생님입니다.
        3. 청취자가 쉽게 이해할 수 있도록 핵심 내용을 대화로 풀어내세요.
        4. ${lectureLength === 2 ? '약 600자' : '약 900자'} 정도의 분량으로 작성하세요.
        5. 한국어로 작성하세요.
      `;

      const scriptResponse = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          { parts: [{ text: scriptPrompt }, contentPart] }
        ],
      });

      const scriptContent = scriptResponse.text;
      if (!scriptContent) throw new Error("스크립트 생성에 실패했습니다.");
      setScript(scriptContent);

      // Step 2: Generate SRT Subtitles
      const srtPrompt = `
        다음 팟캐스트 스크립트를 바탕으로 .srt 형식의 자막 파일을 생성하세요.
        총 길이는 약 ${lectureLength}분(${lectureLength * 60}초)입니다.
        각 대사의 글자 수와 말하는 속도를 고려하여 시작 시간과 종료 시간을 적절히 배분하세요.
        
        스크립트:
        ${scriptContent}
        
        출력 형식: 오직 .srt 파일 내용만 출력하세요.
      `;

      const srtResponse = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts: [{ text: srtPrompt }] }],
      });

      const srtText = srtResponse.text;
      if (srtText) setSrtContent(srtText);

      setStatus('generating_audio');

      // Step 3: Generate Audio (TTS)
      const ttsPrompt = `TTS the following conversation between 줍스 and 쌤:
      ${scriptContent}`;

      const audioResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: ttsPrompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                {
                  speaker: '쌤',
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: 'Aoede' }
                  }
                },
                {
                  speaker: '줍스',
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: 'Puck' }
                  }
                }
              ]
            }
          }
        }
      });

      const base64Audio = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) throw new Error("오디오 생성에 실패했습니다.");

      // Convert Base64 to ArrayBuffer
      const binaryString = atob(base64Audio);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Add WAV Header (Gemini TTS returns raw PCM 16-bit Mono 24kHz)
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
      a.download = `lecture_${lectureLength}min_${Date.now()}.wav`;
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
      a.download = `script_${lectureLength}min_${Date.now()}.txt`;
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
      a.download = `subtitles_${lectureLength}min_${Date.now()}.srt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="min-h-screen bg-paper text-[#1A1A1A] font-sans p-4 md:p-8 selection:bg-olive/20">
      <div className="max-w-2xl mx-auto">
        {/* Header - Styled like '한장짜리' */}
        <header className="flex flex-col items-center text-center mb-16 relative">
          <div className="bg-olive text-white px-4 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest mb-4 shadow-sm">
            CREATED BY ZOOPS
          </div>
          <h1 className="text-7xl font-serif font-bold tracking-tight mb-2">
            <span className="text-emerald-600 italic mr-2 tabular-nums">{lectureLength}</span>
            <span>분 강의</span>
          </h1>
          <p className="text-gray-500 font-serif italic text-lg">줍스의 한장짜리 학습지 강의</p>
          
          <button 
            onClick={() => setIsSettingsOpen(true)}
            className="absolute right-0 top-1/2 -translate-y-1/2 p-2 hover:bg-white rounded-full transition-all shadow-sm border border-gray-200 bg-white/50"
          >
            <Settings className="w-5 h-5 text-gray-600" />
          </button>
        </header>

        {/* Main Card */}
        <div className="bg-white rounded-[40px] shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-gray-100 p-10 mb-10">
          <div className="space-y-10">
            {/* File Upload */}
            <div className="space-y-4">
              <label className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400 ml-1">강의 자료 업로드</label>
              <div 
                className={`relative group border-2 border-dashed rounded-3xl p-10 transition-all flex flex-col items-center justify-center cursor-pointer
                  ${file ? 'border-emerald-200 bg-emerald-50/20' : 'border-gray-100 hover:border-emerald-200 hover:bg-emerald-50/10'}`}
                onClick={() => document.getElementById('fileInput')?.click()}
              >
                <input 
                  id="fileInput"
                  type="file" 
                  className="hidden" 
                  accept="image/*,.md,text/markdown"
                  onChange={handleFileChange}
                />
                
                {file ? (
                  <div className="flex flex-col items-center text-center">
                    <div className="w-14 h-14 bg-emerald-100/50 rounded-2xl flex items-center justify-center mb-4">
                      {fileType === 'image' ? <ImageIcon className="w-7 h-7 text-emerald-600" /> : <FileText className="w-7 h-7 text-emerald-600" />}
                    </div>
                    <p className="font-serif font-bold text-lg text-emerald-900 truncate max-w-[240px]">{file.name}</p>
                    <p className="text-xs text-emerald-600 font-medium mt-1">파일이 선택되었습니다</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center text-center">
                    <div className="w-14 h-14 bg-gray-50 rounded-2xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                      <Upload className="w-7 h-7 text-gray-300" />
                    </div>
                    <p className="font-serif font-bold text-lg text-gray-400">이미지 또는 마크다운 파일</p>
                    <p className="text-xs text-gray-300 font-medium mt-1">클릭하여 업로드하세요</p>
                  </div>
                )}
              </div>
            </div>

            {/* Length Selector */}
            <div className="space-y-4">
              <label className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400 ml-1">강의 시간 선택</label>
              <div className="relative bg-gray-50 p-1.5 rounded-[28px] flex border border-gray-100">
                {/* Sliding Background */}
                <motion.div 
                  className="absolute top-1.5 bottom-1.5 bg-white rounded-[22px] shadow-md border border-gray-100"
                  initial={false}
                  animate={{ 
                    left: lectureLength === 2 ? '6px' : '50%',
                    right: lectureLength === 2 ? '50%' : '6px'
                  }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
                
                {[2, 3].map((len) => (
                  <button
                    key={len}
                    onClick={() => setLectureLength(len as 2 | 3)}
                    className={`relative flex-1 flex flex-col items-center justify-center py-4 z-10 transition-colors duration-300
                      ${lectureLength === len ? 'text-emerald-700' : 'text-gray-400 hover:text-gray-600'}`}
                  >
                    <span className="text-3xl font-serif font-bold tabular-nums">{len}</span>
                    <span className="text-[9px] font-bold uppercase tracking-widest opacity-60">MINUTES</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Generate Button */}
            <button
              onClick={generateLecture}
              disabled={status === 'analyzing' || status === 'generating_audio'}
              className={`w-full py-6 rounded-3xl font-bold text-xl shadow-xl transition-all flex items-center justify-center gap-4
                ${status === 'analyzing' || status === 'generating_audio'
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed shadow-none'
                  : 'bg-black text-white hover:bg-gray-900 active:scale-[0.98]'}`}
            >
              {status === 'analyzing' || status === 'generating_audio' ? (
                <>
                  <Loader2 className="w-7 h-7 animate-spin" />
                  {status === 'analyzing' ? '자료 분석 중...' : '음성 생성 중...'}
                </>
              ) : (
                <>
                  <Mic className="w-7 h-7" />
                  강의 생성하기
                </>
              )}
            </button>
          </div>
        </div>

        {/* Status & Audio Player */}
        <AnimatePresence>
          {status === 'success' && audioUrl && (
            <motion.div 
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-emerald-50/50 border border-emerald-100 rounded-[40px] p-10 flex flex-col items-center text-center"
            >
              <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mb-6 shadow-sm">
                <CheckCircle2 className="w-10 h-10 text-emerald-600" />
              </div>
              <h3 className="text-3xl font-serif font-bold text-emerald-900 mb-3">강의가 완성되었습니다!</h3>
              <p className="text-emerald-700 font-serif italic text-lg mb-10">줍스와 쌤의 대화형 강의를 들어보세요.</p>
              
              <div className="w-full bg-white rounded-[32px] p-8 flex flex-col gap-8 shadow-sm border border-emerald-100/50">
                <div className="flex items-center gap-6">
                  <button 
                    onClick={togglePlay}
                    className="w-16 h-16 bg-emerald-600 rounded-full flex items-center justify-center text-white hover:bg-emerald-700 transition-all shadow-lg active:scale-95"
                  >
                    {isPlaying ? <Pause className="w-7 h-7" /> : <Play className="w-7 h-7 ml-1" />}
                  </button>
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2 mb-2">
                      <Volume2 className="w-4 h-4 text-emerald-600" />
                      <span className="text-sm font-bold text-gray-700">{lectureLength}분 교육 팟캐스트</span>
                    </div>
                    <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-emerald-500 transition-all duration-100 ease-linear"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <button 
                    onClick={downloadAudio}
                    className="flex items-center justify-center gap-2 py-4 bg-gray-50 hover:bg-gray-100 rounded-2xl text-gray-600 font-bold text-xs transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    오디오
                  </button>
                  <button 
                    onClick={downloadScript}
                    className="flex items-center justify-center gap-2 py-4 bg-gray-50 hover:bg-gray-100 rounded-2xl text-gray-600 font-bold text-xs transition-colors"
                  >
                    <FileDown className="w-4 h-4" />
                    스크립트
                  </button>
                  <button 
                    onClick={downloadSRT}
                    disabled={!srtContent}
                    className="flex items-center justify-center gap-2 py-4 bg-gray-50 hover:bg-gray-100 rounded-2xl text-gray-600 font-bold text-xs transition-colors disabled:opacity-50"
                  >
                    <FileText className="w-4 h-4" />
                    자막(.srt)
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

        {/* Footer */}
        <footer className="mt-20 text-center text-gray-400 text-xs tracking-widest uppercase font-bold">
          <p>© 2026 2분강의. All rights reserved.</p>
          <div className="flex items-center justify-center gap-6 mt-4">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
              <span>줍스 (Puck)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
              <span>쌤 (Charon)</span>
            </div>
          </div>
        </footer>
      </div>

      {/* Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => apiKey && setIsSettingsOpen(false)}
              className="absolute inset-0 bg-olive/20 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 30 }}
              className="relative bg-white rounded-[40px] shadow-2xl p-10 w-full max-w-md border border-gray-100"
            >
              <h2 className="text-3xl font-serif font-bold mb-3">API 설정</h2>
              <p className="text-gray-500 mb-8 text-sm font-medium">Gemini API 키를 입력하여 서비스를 시작하세요.</p>
              
              <div className="space-y-6">
                <div className="space-y-3">
                  <label className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400 ml-1">Gemini API Key</label>
                  <input 
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="AI... (API 키를 입력하세요)"
                    className="w-full p-5 bg-gray-50 border border-gray-100 rounded-3xl focus:ring-2 focus:ring-emerald-500 outline-none transition-all font-mono text-sm"
                  />
                </div>
                <button 
                  onClick={() => setIsSettingsOpen(false)}
                  disabled={!apiKey}
                  className="w-full py-5 bg-black text-white rounded-3xl font-bold text-lg hover:bg-gray-900 disabled:bg-gray-100 disabled:text-gray-300 transition-all shadow-lg"
                >
                  저장하기
                </button>
                <p className="text-[10px] text-center text-gray-400 font-medium leading-relaxed">
                  입력하신 API 키는 브라우저 로컬 스토리지에 안전하게 저장됩니다.
                </p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
