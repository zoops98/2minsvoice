import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

let html = await readFile('dist/source.html', 'utf8');
const script = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/);
const style = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
if (!script || !style) throw new Error('빌드된 앱의 스크립트 또는 스타일을 찾을 수 없습니다.');
const assetPath = (url) => path.join('dist', url.replace(/^\//, ''));
const js = await readFile(assetPath(script[1]), 'utf8');
const css = await readFile(assetPath(style[1]), 'utf8');
html = html.replace(script[0], () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`);
html = html.replace(style[0], () => `<style>${css}</style>`);
await writeFile('index.html', html, 'utf8');
console.log('단일 index.html 생성 완료');
