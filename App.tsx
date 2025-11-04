import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { UploadIcon, PdfIcon, DownloadIcon, SpinnerIcon, EditIcon } from './components/icons';
import { summarizePdfText, editImageWithText } from './services/geminiService';
import type { CompressionOptions, OutputFormat, CompressionLevel, ProcessedFile, AppStatus } from './types';

// TypeScript declarations for global libraries from CDN
declare var pdfjsLib: any;
declare var jspdf: any;

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const dataURLToBlob = (dataUrl: string): Blob => {
    const arr = dataUrl.split(',');
    if (arr.length < 2) {
        throw new Error('Invalid data URL');
    }
    const mimeMatch = arr[0].match(/:(.*?);/);
    if (!mimeMatch || mimeMatch.length < 2) {
        throw new Error('Could not parse MIME type from data URL');
    }
    const mime = mimeMatch[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
};

// Helper function to generate a preview for a PDF blob
const generatePdfPreview = async (pdfBlob: Blob): Promise<string> => {
    const arrayBuffer = await pdfBlob.arrayBuffer();
    const typedarray = new Uint8Array(arrayBuffer);
    const pdf = await pdfjsLib.getDocument(typedarray).promise;
    const page = await pdf.getPage(1); // Get the first page

    const scale = 0.5; // Render at a smaller scale for a thumbnail
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    if (!context) {
        throw new Error('Could not get canvas context for preview');
    }

    await page.render({ canvasContext: context, viewport: viewport }).promise;
    return canvas.toDataURL('image/png');
};


const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState<CompressionOptions>({ format: 'jpeg', level: 'medium' });
  const [status, setStatus] = useState<AppStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [results, setResults] = useState<ProcessedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingState, setEditingState] = useState<{ index: number; prompt: string; isLoading: boolean } | null>(null);

  useEffect(() => {
    return () => {
      // Revoke Object URLs to prevent memory leaks when component unmounts or results change.
      results.forEach(result => {
        if (result.dataUrl.startsWith('blob:')) {
          URL.revokeObjectURL(result.dataUrl);
        }
      });
    };
  }, [results]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles && acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      if (selectedFile.type !== "application/pdf") {
        setError("Invalid file type. Please upload a PDF.");
        return;
      }
      setFile(selectedFile);
      setStatus('idle');
      setResults([]);
      setError(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    multiple: false,
  });

  const getQuality = (): number => {
    switch (options.level) {
      case 'low': return 0.5;
      case 'medium': return 0.75;
      case 'high': return 0.92;
      default: return 0.75;
    }
  };

  const handleCompress = async () => {
    if (!file) return;

    setStatus('processing');
    setResults([]);
    setError(null);
    setEditingState(null);

    try {
      const fileReader = new FileReader();
      fileReader.readAsArrayBuffer(file);

      fileReader.onload = async (e) => {
        if (!e.target?.result) {
            setError('Failed to read file.');
            setStatus('error');
            return;
        }

        const typedarray = new Uint8Array(e.target.result as ArrayBuffer);
        const pdf = await pdfjsLib.getDocument(typedarray).promise;

        if (options.format === 'pdf') {
          // Gemini AI summarization
          setStatusMessage('Extracting text from PDF...');
          let fullText = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map((item: any) => item.str).join(' ');
            fullText += pageText + '\n\n';
          }

          setStatusMessage('AI is summarizing the content...');
          const summarizedText = await summarizePdfText(fullText);

          setStatusMessage('Generating new PDF...');
          const { jsPDF } = jspdf;
          const doc = new jsPDF();
          const splitText = doc.splitTextToSize(summarizedText, 180);
          doc.text(splitText, 15, 20);
          
          const compressedBlob = doc.output('blob');
          const dataUrl = URL.createObjectURL(compressedBlob);

          setStatusMessage('Generating preview...');
          const previewUrl = await generatePdfPreview(compressedBlob);

          setResults([{
            name: `${file.name.replace('.pdf', '')}_summary.pdf`,
            dataUrl,
            previewUrl,
            originalSize: file.size,
            compressedSize: compressedBlob.size,
          }]);

        } else {
          // Image conversion
          const processed: ProcessedFile[] = [];
          const originalSizePerPage = Math.round(file.size / pdf.numPages);

          for (let i = 1; i <= pdf.numPages; i++) {
            setStatusMessage(`Converting page ${i} of ${pdf.numPages}...`);
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            if (context) {
                await page.render({ canvasContext: context, viewport: viewport }).promise;
                const mimeType = `image/${options.format}`;
                const dataUrl = canvas.toDataURL(mimeType, getQuality());
                const compressedBlob = dataURLToBlob(dataUrl);

                processed.push({
                    name: `${file.name.replace('.pdf', '')}_page_${i}.${options.format}`,
                    dataUrl,
                    previewUrl: dataUrl, // Image data URL serves as its own preview
                    originalSize: originalSizePerPage,
                    compressedSize: compressedBlob.size,
                });
            }
          }
          setResults(processed);
        }
        setStatus('success');
      };

      fileReader.onerror = () => {
        setError('Error reading file.');
        setStatus('error');
      };
    } catch (err: any) {
      setError(err.message || 'An unknown error occurred during compression.');
      setStatus('error');
    }
  };
  
  const handleApplyEdit = async () => {
    if (!editingState) return;
  
    setEditingState({ ...editingState, isLoading: true });
    setError(null);
  
    try {
      const { index, prompt } = editingState;
      if (!prompt) {
        throw new Error("Please enter an edit description.");
      }
      const originalFile = results[index];
  
      const dataUrl = originalFile.dataUrl;
      const parts = dataUrl.split(',');
      if (parts.length !== 2) throw new Error("Invalid Data URL");
      
      const mimeMatch = parts[0].match(/:(.*?);/);
      if (!mimeMatch) throw new Error("Could not determine MIME type");
  
      const mimeType = mimeMatch[1];
      const base64Data = parts[1];
  
      const newBase64Data = await editImageWithText(base64Data, mimeType, prompt);
  
      const newDataUrl = `data:${mimeType};base64,${newBase64Data}`;
      const newBlob = dataURLToBlob(newDataUrl);
  
      const updatedFile: ProcessedFile = {
        ...originalFile,
        name: originalFile.name.replace(/(\.[\w\d_-]+)$/i, '_edited$1'),
        dataUrl: newDataUrl,
        previewUrl: newDataUrl,
        compressedSize: newBlob.size,
      };
  
      setResults(currentResults => {
        const newResults = [...currentResults];
        newResults[index] = updatedFile;
        return newResults;
      });
  
      setEditingState(null);
  
    } catch (err: any) {
      setError(err.message || "An error occurred during AI editing.");
      if (editingState) {
          setEditingState({ ...editingState, isLoading: false });
      }
    }
  };

  const handleReset = () => {
    setFile(null);
    setResults([]);
    setStatus('idle');
    setError(null);
    setStatusMessage('');
    setEditingState(null);
  };

  const totalOriginalSize = useMemo(() => file?.size || 0, [file]);
  const totalCompressedSize = useMemo(() => results.reduce((sum, r) => sum + r.compressedSize, 0), [results]);
  const totalSavings = useMemo(() => {
    if (totalOriginalSize === 0 || totalCompressedSize === 0) return 0;
    return Math.round(((totalOriginalSize - totalCompressedSize) / totalOriginalSize) * 100);
  }, [totalOriginalSize, totalCompressedSize]);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-2xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl md:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-indigo-500">PDF Compressor Pro</h1>
          <p className="text-slate-400 mt-2">Reduce, convert, and now edit your PDFs with AI.</p>
        </header>

        <main className="bg-slate-800/50 rounded-2xl shadow-2xl p-6 md:p-8 backdrop-blur-sm border border-slate-700">
          {!file ? (
            <div {...getRootProps()} className={`cursor-pointer p-10 border-2 border-dashed rounded-lg text-center transition-colors ${isDragActive ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-600 hover:border-slate-500'}`}>
              <input {...getInputProps()} />
              <UploadIcon className="w-12 h-12 mx-auto text-slate-500 mb-4" />
              <p className="text-slate-300 font-semibold">Drag & drop a PDF file here</p>
              <p className="text-slate-400 text-sm mt-1">or click to select a file</p>
            </div>
          ) : (
            <div>
              <div className="flex items-center bg-slate-700/50 p-4 rounded-lg">
                <PdfIcon className="w-10 h-10 text-red-400 flex-shrink-0" />
                <div className="ml-4 overflow-hidden">
                  <p className="font-semibold text-slate-200 truncate">{file.name}</p>
                  <p className="text-sm text-slate-400">{formatFileSize(file.size)}</p>
                </div>
                <button onClick={handleReset} className="ml-auto text-sm text-slate-400 hover:text-white transition-colors">Change file</button>
              </div>

              <div className="my-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Output Format</label>
                  <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-700/50 p-1">
                    {(['jpeg', 'png', 'pdf'] as OutputFormat[]).map(format => (
                      <button key={format} onClick={() => setOptions(o => ({ ...o, format }))} className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors ${options.format === format ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-600/50'}`}>
                        {format.toUpperCase()}{format === 'pdf' ? ' (AI)' : ''}
                      </button>
                    ))}
                  </div>
                </div>

                {options.format !== 'pdf' && (
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Image Quality</label>
                    <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-700/50 p-1">
                      {(['low', 'medium', 'high'] as CompressionLevel[]).map(level => (
                        <button key={level} onClick={() => setOptions(o => ({ ...o, level }))} className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors capitalize ${options.level === level ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-600/50'}`}>
                          {level}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={handleCompress}
                disabled={status === 'processing'}
                className="w-full bg-indigo-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-indigo-700 disabled:bg-indigo-800/50 disabled:cursor-not-allowed transition-all flex items-center justify-center"
              >
                {status === 'processing' ? <><SpinnerIcon /> {statusMessage || 'Compressing...'}</> : 'Compress File'}
              </button>
            </div>
          )}

          {error && <div className="mt-4 text-center bg-red-500/20 text-red-300 p-3 rounded-lg text-sm">{error}</div>}

          {status === 'success' && results.length > 0 && (
            <div className="mt-8">
              <h2 className="text-xl font-bold text-center mb-2">Compression Complete!</h2>
                {totalSavings > 0 && <p className="text-center text-green-400 font-semibold mb-4">Total size reduction: {totalSavings}%</p>}
              <div className="space-y-3 max-h-96 overflow-y-auto pr-2">
                {results.map((res, index) => {
                  const isImage = res.name.endsWith('.jpeg') || res.name.endsWith('.png');
                  const isEditingThis = editingState?.index === index;
                  return (
                    <div key={res.name} className="bg-slate-700/50 rounded-lg transition-all shadow-md">
                        <div className="flex items-center p-3">
                        {res.previewUrl && (
                            <img 
                                src={res.previewUrl} 
                                alt={`Preview of ${res.name}`}
                                className="w-14 h-14 object-cover rounded-md mr-4 flex-shrink-0 bg-white shadow-md"
                            />
                        )}
                        <div className="overflow-hidden flex-1">
                          <p className="font-semibold text-slate-200 truncate">{res.name}</p>
                          <p className="text-sm text-slate-400">
                            {formatFileSize(res.compressedSize)} 
                            <span className="text-slate-500"> (from ~{formatFileSize(res.originalSize)})</span>
                          </p>
                        </div>
                        <div className="ml-4 flex items-center gap-2 flex-shrink-0">
                           {isImage && (
                            <button onClick={() => setEditingState({ index, prompt: '', isLoading: false })} disabled={!!editingState} className="text-slate-300 p-2 rounded-md hover:bg-slate-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                                <EditIcon className="w-5 h-5"/>
                            </button>
                           )}
                           <a href={res.dataUrl} download={res.name} className="bg-slate-600 text-white p-2 rounded-md hover:bg-slate-500 transition-colors">
                              <DownloadIcon className="w-5 h-5" />
                            </a>
                        </div>
                      </div>
                      {isEditingThis && (
                        <div className="p-3 border-t border-slate-600/50">
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    placeholder="e.g., add a retro filter, make it grayscale..."
                                    value={editingState.prompt}
                                    onChange={(e) => setEditingState({ ...editingState, prompt: e.target.value })}
                                    disabled={editingState.isLoading}
                                    className="w-full bg-slate-800 border border-slate-600 text-sm rounded-md px-3 py-2 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                />
                                <button onClick={handleApplyEdit} disabled={editingState.isLoading || !editingState.prompt} className="bg-indigo-600 text-white font-semibold px-4 py-2 rounded-md hover:bg-indigo-700 disabled:bg-indigo-800/50 disabled:cursor-not-allowed transition-colors text-sm flex-shrink-0">
                                    {editingState.isLoading ? <SpinnerIcon /> : 'Apply'}
                                </button>
                                <button onClick={() => setEditingState(null)} disabled={editingState.isLoading} className="text-slate-400 hover:text-white transition-colors text-sm px-2 py-2">Cancel</button>
                            </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
