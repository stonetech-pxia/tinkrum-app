import type { ToolDefinition } from '../registry';
import { audioTool } from './audio';
import { imageTool } from './image';
import { printTool, qrTool, textTool, zipTool } from './more';
import { ocrTool } from './ocr';
import { pdfTool } from './pdf';
import { scanTool } from './scan';
import { translateTool } from './translate';
import { videoTool } from './video';

export * from './audio';
export * from './image';
export * from './more';
export * from './ocr';
export * from './pdf';
export * from './scan';
export * from './translate';
export * from './video';

/** Directory of built-in tools distributed with the app. Tool code is not restored across historical versions (§7E). */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  pdfTool,
  imageTool,
  videoTool,
  audioTool,
  scanTool,
  ocrTool,
  translateTool,
  zipTool,
  qrTool,
  textTool,
  printTool,
];
