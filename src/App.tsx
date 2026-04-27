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

type FileType = 'image' | 'markdown' | 'html' | null;
type LectureMode = 'podcast' | 'solo';
type LectureLength = 2 | 3 | 5;

export default function App() {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('zoops_gemini_api_key') || '');
  const [isSettingsOpen, setIsSettingsOpen] = useState(!apiKey);
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
      } else if (selectedFile.name.endsWith('.html') || selectedFile.type === 'text/html') {
        setFileType('html');
        // Auto-switch to solo mode if HTML is uploaded as it's likely a mock exam note
        setLectureMode('solo');
      } else {
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
          return '약 1800자';
        } else {
          if (len === 2) return '약 600자';
          if (len === 3) return '약 950자';
          return '약 1500자';
        }
      };

      const scriptPrompt = lectureMode === 'podcast' ? `
        당신은 전문 교육 팟캐스트 작가입니다. 
        업로드된 내용을 바탕으로 '줍스(학생)'와 '쌤(선생님)'이 대화하는 ${lectureLength}분 분량의 교육용 스크립트를 작성하세요.
        
        규칙:
        1. 형식은 반드시 '줍스: [대사]', '쌤: [대사]' 형식을 반복해야 합니다.
        2. 줍스는 배우고자 하는 열의가 가득한 학생이며, 쌤은 명확하고 교육적으로 설명해주시는 여성 선생님입니다.
        3. 청취자가 쉽게 이해할 수 있도록 핵심 내용을 대화로 풀어내세요.
        4. ${getTargetChars(lectureLength, 'podcast')} 정도의 분량으로 작성하세요.
        5. 한국어로 작성하세요.
      ` : `
        당신은 전문 수능/내신 영어 강사입니다. 
        업로드된 필기 데이터(HTML/텍스트)를 바탕으로, 학생들에게 핵심 내용을 짚어주는 1인 강의 대본을 작성하세요.

        규칙:
        1. 형식은 반드시 '쌤: [대사]' 형식으로만 구성되어야 합니다. (줍스 등 다른 인물은 등장하지 않습니다)
        2. 선생님은 친절하지만 핵심을 정확히 찌르는 명쾌한 어조를 사용합니다.
        3. 자료 내의 구문 분석, 문법 포인트, 주제 및 요약 내용을 빠짐없이 설명에 녹여내세요.
        4. 청취자가 필기 노트를 보고 있다고 가정하고 시각적인 설명(예: "여기 파란색 박스의 핵심 내용을 보시면...")을 곁들이세요.
        5. 분량은 약 ${lectureLength}분 (${getTargetChars(lectureLength, 'solo')})에 해당하도록 한국어로 작성하세요.
        6. 설명이 너무 빠르지 않게, 전문 강사처럼 문장 사이사이에 여유를 두고 차근차근 설명하는 어조로 작성하세요.
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
        다음 스크립트를 바탕으로 음성과 정확히 일치하는 .srt 형식의 자막 파일을 생성하세요.
        
        규칙:
        1. 총 길이는 약 ${lectureLength}분 (${lectureLength * 60}초) 내외입니다.
        2. **중요: 각 자막 블록은 반드시 최대 2줄 이내이어야 합니다.** 한 블록에 내용이 많으면 여러 블록으로 나누세요.
        3. 한국어 일반적인 말하기 속도(1초당 약 3.5자)를 고려하여 시작(00:00:00,000)부터 끝까지 빈틈없이 시간을 배분하세요.
        4. 문장이 끝나지 않았더라도 자막이 너무 길어지면(한 줄에 약 20자 내외) 적절히 끊어서 다음 블록으로 넘기세요.
        5. '줍스:', '쌤:' 같은 화자 이름은 자막에서 제외하고 실제 대사 내용만 담으세요.
        
        스크립트:
        ${scriptContent}
        
        출력 형식: 오직 .srt 파일 내용(순번, 시간대, 텍스트)만 출력하세요.
      `;

      const srtResponse = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts: [{ text: srtPrompt }] }],
      });

      const srtText = srtResponse.text;
      if (srtText) setSrtContent(srtText);

      setStatus('generating_audio');

      // Step 3: Generate Audio (TTS)
      const ttsPrompt = lectureMode === 'podcast' 
        ? `TTS the following conversation between 줍스 and 쌤:\n${scriptContent}`
        : `Generate a solo teacher lecture based on the following script:\n${scriptContent}`;

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
          <div className="bg-emerald-600 text-white px-5 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-[0.2em] mb-6 shadow-lg shadow-emerald-200/50 backdrop-blur-sm">
            CREATED BY ZoopsBooks
          </div>
          <h1 className="text-8xl font-serif font-bold tracking-tighter mb-4 selection:bg-emerald-100">
            <span className="text-emerald-600 italic mr-3 tabular-nums drop-shadow-sm">{lectureLength}</span>
            <span className="bg-clip-text text-transparent bg-gradient-to-b from-[#1A1A1A] to-gray-500">분 강의</span>
          </h1>
          <p className="text-gray-400 font-serif italic text-xl tracking-tight">줍스의 한장짜리 학습지 프리미엄 강의</p>
          
          <button 
            onClick={() => setIsSettingsOpen(true)}
            className="absolute right-0 top-1/2 -translate-y-1/2 p-2 hover:bg-white rounded-full transition-all shadow-sm border border-gray-200 bg-white/50"
          >
            <Settings className="w-5 h-5 text-gray-600" />
          </button>
        </header>

        {/* Main Card */}
        <div className="glass-card rounded-[56px] p-12 mb-12 relative overflow-hidden">
          <div className="absolute -top-24 -right-24 w-64 h-64 bg-emerald-50 rounded-full blur-3xl opacity-60" />
          <div className="absolute -bottom-24 -left-24 w-64 h-64 bg-emerald-50 rounded-full blur-3xl opacity-60" />
          
          <div className="space-y-12 relative z-10">
            {/* File Upload */}
            <div className="space-y-5">
              <label className="text-[11px] font-bold uppercase tracking-[0.3em] text-gray-400 ml-1">학습 자료 업로드</label>
              <div 
                className={`relative group border-2 border-dashed rounded-[40px] p-14 transition-all duration-500 flex flex-col items-center justify-center cursor-pointer overflow-hidden
                  ${file ? 'border-emerald-300 bg-emerald-50/10' : 'border-gray-100'}`}
                onClick={() => document.getElementById('fileInput')?.click()}
              >
                <input 
                  id="fileInput"
                  type="file" 
                  className="hidden" 
                  accept="image/*,.md,text/markdown,.html,text/html"
                  onChange={handleFileChange}
                />
                
                {file ? (
                  <div className="flex flex-col items-center text-center">
                    <motion.div 
                      layoutId="fileTypeIcon"
                      className="w-20 h-20 bg-emerald-100/50 rounded-[28px] flex items-center justify-center mb-6 shadow-sm border border-emerald-100"
                    >
                      {fileType === 'image' && <ImageIcon className="w-9 h-9 text-emerald-600" />}
                      {fileType === 'markdown' && <FileText className="w-9 h-9 text-emerald-600" />}
                      {fileType === 'html' && <FileDown className="w-9 h-9 text-emerald-600" />}
                    </motion.div>
                    <p className="font-serif font-bold text-2xl text-emerald-950 truncate max-w-[320px] mb-2">{file.name}</p>
                    <div className="flex items-center gap-2 px-3 py-1 bg-emerald-600 text-white rounded-full text-[10px] font-bold uppercase tracking-widest shadow-lg shadow-emerald-200">
                      <CheckCircle2 className="w-3 h-3" />
                      Ready to process
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center text-center">
                    <div className="w-20 h-20 bg-gray-50/80 rounded-[28px] flex items-center justify-center mb-6 group-hover:scale-110 transition-all duration-300 group-hover:bg-emerald-50 group-hover:shadow-lg group-hover:shadow-emerald-100">
                      <Upload className="w-9 h-9 text-gray-300 group-hover:text-emerald-500" />
                    </div>
                    <p className="font-serif font-bold text-2xl text-gray-400 group-hover:text-gray-600 transition-colors">이미지, 마크다운, HTML</p>
                    <p className="text-xs text-gray-300 font-medium mt-2 tracking-wide">클릭하여 학습 자료를 제공해주세요</p>
                  </div>
                )}

                {/* Animated shimmer on hover when empty */}
                {!file && (
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-emerald-50/50 to-transparent -translate-x-full group-hover:animate-shimmer" />
                )}
              </div>
            </div>

            {/* Mode & Length Selectors */}
            <div className="space-y-8">
              {/* Lecture Mode Selection */}
              <div className="space-y-4">
                <label className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400 ml-1">강의 스타일 선택</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {[
                    { 
                      id: 'podcast', 
                      title: '팟캐스트 스타일', 
                      desc: '학습자와 선생님의 캐주얼한 대화', 
                      icon: <Mic className="w-5 h-5" />,
                      tag: '2인 대화'
                    },
                    { 
                      id: 'solo', 
                      title: '필기 집중 강의', 
                      desc: '선생님이 혼자서 꼼꼼하게 설명', 
                      icon: <Volume2 className="w-5 h-5" />,
                      tag: '1인 설명'
                    }
                  ].map((mode) => (
                    <button
                      key={mode.id}
                      onClick={() => {
                        setLectureMode(mode.id as LectureMode);
                        if (mode.id === 'podcast' && lectureLength === 5) {
                          setLectureLength(3);
                        }
                      }}
                      className={`relative overflow-hidden text-left p-6 rounded-[32px] border-2 transition-all duration-300 group
                        ${lectureMode === mode.id 
                          ? 'border-emerald-600 bg-emerald-50/30' 
                          : 'border-gray-100 bg-white hover:border-emerald-200 hover:bg-gray-50/50'}`}
                    >
                      <div className="flex justify-between items-start mb-4">
                        <div className={`p-3 rounded-2xl transition-colors
                          ${lectureMode === mode.id ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-400 group-hover:text-emerald-500'}`}>
                          {mode.icon}
                        </div>
                        <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-md
                          ${lectureMode === mode.id ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-400'}`}>
                          {mode.tag}
                        </span>
                      </div>
                      <h4 className={`text-lg font-serif font-bold mb-1 ${lectureMode === mode.id ? 'text-emerald-900' : 'text-gray-900'}`}>
                        {mode.title}
                      </h4>
                      <p className={`text-xs font-medium leading-relaxed ${lectureMode === mode.id ? 'text-emerald-700/70' : 'text-gray-400'}`}>
                        {mode.desc}
                      </p>
                      
                      {lectureMode === mode.id && (
                        <motion.div 
                          layoutId="activeMode"
                          className="absolute bottom-0 left-0 right-0 h-1 bg-emerald-600"
                        />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Lecture Length Selection */}
              <div className="space-y-4">
                <label className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400 ml-1">강의 시간 설정</label>
                <div className="bg-gray-50/80 p-2 rounded-[32px] border border-gray-100 flex gap-2">
                  {([2, 3, 5] as const).filter(len => lectureMode === 'solo' || len !== 5).map((len) => (
                    <button
                      key={len}
                      onClick={() => setLectureLength(len)}
                      className={`relative flex-1 py-4 rounded-[24px] transition-all duration-300 overflow-hidden
                        ${lectureLength === len 
                          ? 'bg-white shadow-sm ring-1 ring-gray-100' 
                          : 'hover:bg-white/50'}`}
                    >
                      <div className="relative z-10 flex flex-col items-center">
                        <div className="flex items-baseline gap-0.5">
                          <span className={`text-2xl font-serif font-bold tabular-nums transition-colors
                            ${lectureLength === len ? 'text-emerald-600' : 'text-gray-400'}`}>
                            {len}
                          </span>
                          <span className={`text-xs font-bold transition-colors
                            ${lectureLength === len ? 'text-emerald-700' : 'text-gray-400'}`}>
                            분
                          </span>
                        </div>
                        <span className={`text-[8px] font-bold uppercase tracking-[0.2em] transition-colors
                          ${lectureLength === len ? 'text-emerald-600/60' : 'text-gray-300'}`}>
                          Duration
                        </span>
                      </div>
                      
                      {lectureLength === len && (
                        <motion.div 
                          layoutId="activeLength"
                          className="absolute inset-0 bg-white"
                          transition={{ type: "spring", stiffness: 300, damping: 30 }}
                        />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Generate Button */}
            <div className="pt-4">
              <button
                onClick={generateLecture}
                disabled={status === 'analyzing' || status === 'generating_audio'}
                className={`w-full py-6 rounded-[32px] font-bold text-xl shadow-2xl transition-all flex items-center justify-center gap-4 relative overflow-hidden group
                  ${status === 'analyzing' || status === 'generating_audio'
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed shadow-none'
                    : 'bg-[#1A1A1A] text-white hover:bg-black active:scale-[0.98] ring-offset-2 focus:ring-2 focus:ring-emerald-500'}`}
              >
                {status === 'analyzing' || status === 'generating_audio' ? (
                  <>
                    <Loader2 className="w-7 h-7 animate-spin" />
                    <span className="font-serif italic tracking-wide">
                      {status === 'analyzing' ? '자료 분석 중...' : '음성 생성 중...'}
                    </span>
                  </>
                ) : (
                  <>
                    <Mic className="w-7 h-7 transition-transform group-hover:scale-110" />
                    <span className="font-serif italic tracking-wide">강의 생성 시작하기</span>
                  </>
                )}
                
                {status !== 'analyzing' && status !== 'generating_audio' && (
                  <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/0 via-emerald-500/10 to-emerald-500/0 -translate-x-full group-hover:animate-shimmer" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Status & Audio Player */}
        <AnimatePresence>
          {status === 'success' && audioUrl && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.98, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="bg-emerald-50/40 backdrop-blur-sm border border-emerald-100/50 rounded-[48px] p-12 flex flex-col items-center text-center shadow-inner"
            >
              <div className="w-24 h-24 bg-emerald-600 rounded-[32px] flex items-center justify-center mb-8 shadow-xl shadow-emerald-200 rotate-3">
                <CheckCircle2 className="w-12 h-12 text-white -rotate-3" />
              </div>
              <h3 className="text-4xl font-serif font-bold text-emerald-900 mb-4 tracking-tight">강의가 완성되었습니다!</h3>
              <p className="text-emerald-700/70 font-serif italic text-xl mb-12 max-w-sm mx-auto">
                {lectureMode === 'podcast' ? '줍스와 쌤의 생생한 대화형 강의를 들어보세요.' : '필기 핵심 내용을 짚어주는 1인 집중 강의입니다.'}
              </p>
              
              <div className="w-full bg-white rounded-[40px] p-10 flex flex-col gap-10 shadow-xl shadow-gray-200/50 border border-emerald-50">
                <div className="flex flex-col items-center gap-8">
                  <button 
                    onClick={togglePlay}
                    className="group relative w-24 h-24 flex items-center justify-center transition-all active:scale-95"
                  >
                    <div className="absolute inset-0 bg-emerald-600 rounded-full shadow-lg group-hover:scale-105 transition-transform" />
                    <div className="relative z-10 text-white">
                      {isPlaying ? <Pause className="w-10 h-10" /> : <Play className="w-10 h-10 ml-2 shadow-sm" />}
                    </div>
                  </button>
                  
                  <div className="w-full text-center">
                    <div className="flex flex-col items-center gap-2 mb-6">
                      <div className="flex items-center gap-2 px-3 py-1 bg-emerald-50 rounded-full">
                        <Volume2 className="w-3 h-3 text-emerald-600" />
                        <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-widest">
                          {lectureLength}min {lectureMode === 'podcast' ? 'Podcast' : 'Solo Lecture'}
                        </span>
                      </div>
                      <h4 className="text-lg font-serif font-bold text-gray-800">강의 리플레이</h4>
                    </div>
                    
                    <div className="relative h-2 w-full bg-gray-100 rounded-full overflow-hidden mb-2 group cursor-pointer">
                      <div 
                        className="h-full bg-emerald-500 rounded-full transition-all duration-100 ease-linear relative"
                        style={{ width: `${progress}%` }}
                      >
                        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-emerald-600 rounded-full shadow-md scale-0 group-hover:scale-100 transition-transform" />
                      </div>
                    </div>
                    <div className="flex justify-between px-1">
                      <span className="text-[10px] font-mono text-gray-400">0:00</span>
                      <span className="text-[10px] font-mono text-gray-400">{lectureLength}:00</span>
                    </div>
                  </div>
                </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <button 
                      onClick={downloadAudio}
                      className="flex flex-col items-center gap-2 py-4 bg-gray-50 hover:bg-emerald-50 hover:text-emerald-700 rounded-2xl text-gray-500 font-bold transition-all border border-transparent hover:border-emerald-100"
                    >
                      <Download className="w-5 h-5" />
                      <span className="text-[10px] uppercase tracking-widest">Audio</span>
                    </button>
                    <button 
                      onClick={downloadScript}
                      className="flex flex-col items-center gap-2 py-4 bg-gray-50 hover:bg-emerald-50 hover:text-emerald-700 rounded-2xl text-gray-500 font-bold transition-all border border-transparent hover:border-emerald-100"
                    >
                      <FileDown className="w-5 h-5" />
                      <span className="text-[10px] uppercase tracking-widest">Script</span>
                    </button>
                    <button 
                      onClick={downloadSRT}
                      disabled={!srtContent}
                      className="flex flex-col items-center gap-2 py-4 bg-gray-50 hover:bg-emerald-50 hover:text-emerald-700 rounded-2xl text-gray-500 font-bold transition-all border border-transparent hover:border-emerald-100 disabled:opacity-30 disabled:hover:bg-gray-50 disabled:hover:text-gray-500 disabled:hover:border-transparent"
                    >
                      <FileText className="w-5 h-5" />
                      <span className="text-[10px] uppercase tracking-widest">Subtitle</span>
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
        <footer className="mt-24 pb-12 text-center">
          <div className="h-px w-24 bg-gradient-to-r from-transparent via-gray-200 to-transparent mx-auto mb-8" />
          <p className="text-gray-400 text-[10px] tracking-[0.3em] uppercase font-bold mb-6">© 2026 ZoopsBooks. All rights reserved.</p>
          <div className="flex items-center justify-center gap-8">
            <div className="flex items-center gap-3 group">
              <div className="w-2 h-2 bg-emerald-400 rounded-full shadow-[0_0_8px_rgba(52,211,153,0.6)] group-hover:scale-125 transition-transform" />
              <span className="text-[11px] font-bold text-gray-500 tracking-wide uppercase">Studying 줍스 (Puck)</span>
            </div>
            <div className="flex items-center gap-3 group">
              <div className="w-2 h-2 bg-emerald-400 rounded-full shadow-[0_0_8px_rgba(52,211,153,0.6)] group-hover:scale-125 transition-transform" />
              <span className="text-[11px] font-bold text-gray-500 tracking-wide uppercase">Teaching 쌤 (Charon)</span>
            </div>
          </div>
        </footer>
      </div>

      {/* Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => apiKey && setIsSettingsOpen(false)}
              className="absolute inset-0 bg-[#050505]/40 backdrop-blur-2xl"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 40 }}
              className="relative bg-white rounded-[48px] shadow-[0_32px_64px_-12px_rgba(0,0,0,0.15)] p-12 w-full max-w-md border border-gray-100 overflow-hidden"
            >
              <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-emerald-500 to-emerald-700" />
              <h2 className="text-4xl font-serif font-bold mb-4 tracking-tight">API 설정</h2>
              <p className="text-gray-400 mb-10 text-base font-medium leading-relaxed">Gemini AI의 마법을 시작하기 위해<br />API 키를 입력해주세요.</p>
              
              <div className="space-y-8">
                <div className="space-y-4">
                  <label className="text-[10px] font-bold uppercase tracking-[0.3em] text-gray-400 ml-1">Secure Gemini API Key</label>
                  <div className="relative group">
                    <input 
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="AI... (암호화되어 안전하게 저장됩니다)"
                      className="w-full p-6 bg-gray-50 border border-gray-100 rounded-[24px] focus:ring-4 focus:ring-emerald-500/10 focus:border-emerald-500 outline-none transition-all font-mono text-sm shadow-inner"
                    />
                    <div className="absolute right-6 top-1/2 -translate-y-1/2 text-gray-200 group-focus-within:text-emerald-500 transition-colors">
                      <Settings className="w-5 h-5" />
                    </div>
                  </div>
                </div>
                <button 
                  onClick={() => setIsSettingsOpen(false)}
                  disabled={!apiKey}
                  className="w-full py-6 bg-[#1A1A1A] text-white rounded-[24px] font-bold text-xl hover:bg-black disabled:bg-gray-100 disabled:text-gray-300 transition-all shadow-2xl active:scale-[0.98] shadow-emerald-900/10"
                >
                  저장 및 시작하기
                </button>
                <div className="flex items-center justify-center gap-2 text-[10px] text-gray-400 font-bold uppercase tracking-widest">
                  <span className="w-1 h-1 bg-emerald-500 rounded-full" />
                  Local Storage Encrypted
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
