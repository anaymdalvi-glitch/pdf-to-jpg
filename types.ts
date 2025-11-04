
export type OutputFormat = 'jpeg' | 'png' | 'pdf';

export type CompressionLevel = 'low' | 'medium' | 'high';

export interface CompressionOptions {
  format: OutputFormat;
  level: CompressionLevel;
}

export interface ProcessedFile {
  name: string;
  dataUrl: string;
  originalSize: number;
  compressedSize: number;
  previewUrl?: string;
}

export type AppStatus = 'idle' | 'processing' | 'success' | 'error';