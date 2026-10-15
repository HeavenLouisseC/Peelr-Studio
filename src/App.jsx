import React, { useState, useRef, useEffect, useCallback } from 'react';
import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers';
import JSZip from 'jszip';
import {
    Sparkles, Layers, Wand2, Loader, Archive, Move, Split,
    Paintbrush, Undo2, Redo2, ChevronsLeftRight, Contact,
    Sliders, Aperture, Image as ImageIcon, Download, Check
} from 'lucide-react';

// Disable local model check so it fetches directly from HuggingFace CDN
env.allowLocalModels = false;

export default function App() {
    // AI Model Refs
    const modelRef = useRef(null);
    const processorRef = useRef(null);

    // Canvas & DOM Refs
    const outputCanvasRef = useRef(null);
    const origCanvasRef = useRef(null);
    const renderWrapperRef = useRef(null);
    const rawMaskRef = useRef(null);
    const origImgRef = useRef(null);
    const customBgImgRef = useRef(null);

    // Undo / Redo History Refs
    const undoStackRef = useRef([]);
    const redoStackRef = useRef([]);
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);

    // App UI State
    const [hasImage, setHasImage] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [progress, setProgress] = useState(0);

    // Tool & Canvas State
    const [activeTool, setActiveTool] = useState('move'); // 'move' | 'compare' | 'brush'
    const [brushMode, setBrushMode] = useState('erase'); // 'erase' | 'restore'
    const [brushSize, setBrushSize] = useState(25);
    const [splitPct, setSplitPct] = useState(50);
    const [ratio, setRatio] = useState('orig');

    // Transform State (Pan, Zoom, Rotate)
    const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1, rotation: 0 });
    const isPanningRef = useRef(false);
    const panStartRef = useRef({ x: 0, y: 0 });
    const isPaintingRef = useRef(false);
    const isDraggingSplitRef = useRef(false);

    // Passport / ID Mode State
    const [idMode, setIdMode] = useState(false);
    const [idDim, setIdDim] = useState({ w: 600, h: 600, label: '2x2 in (US/PH)' });
    const [nametagEnabled, setNametagEnabled] = useState(true);
    const [nametagText, setNametagText] = useState('JUAN C. DELA CRUZ');
    const [nametagSubtext, setNametagSubtext] = useState('STAFF ID: 2026-0891');
    const [nametagBg, setNametagBg] = useState('#ffffff');
    const [nametagColor, setNametagColor] = useState('#000000');
    const [nametagHeightPct, setNametagHeightPct] = useState(16);

    // Backdrop & Sticker State
    const [backdrop, setBackdrop] = useState({ type: 'checker', color: '#ffffff' });
    const [stickerEnabled, setStickerEnabled] = useState(false);
    const [stickerWidth, setStickerWidth] = useState(12);
    const [stickerColor, setStickerColor] = useState('#ffffff');
    const [stickerShadow, setStickerShadow] = useState(true);

    // Batch Queue State
    const [showBatch, setShowBatch] = useState(false);
    const [batchQueue, setBatchQueue] = useState([]);
    const [isBatchProcessing, setIsBatchProcessing] = useState(false);

    // Load RMBG-1.4 Model
    const loadModel = async () => {
        if (modelRef.current && processorRef.current) return;
        setIsLoading(true);
        setStatusText('Loading RMBG-1.4 AI Model (~40MB, cached after 1st run)...');
        modelRef.current = await AutoModel.from_pretrained('briaai/RMBG-1.4', {
            progress_callback: (d) => {
                if (d.status === 'progress') setProgress(Math.round(d.progress));
            }
        });
        processorRef.current = await AutoProcessor.from_pretrained('briaai/RMBG-1.4');
    };

    // Master Canvas Render Pipeline
    const renderComposite = useCallback(() => {
        const outCanvas = outputCanvasRef.current;
        const origCanvas = origCanvasRef.current;
        const origImg = origImgRef.current;
        const rawMask = rawMaskRef.current;
        if (!outCanvas || !origCanvas || !origImg || !rawMask) return;

        let w = origImg.naturalWidth;
        let h = origImg.naturalHeight;

        if (idMode) {
            w = idDim.w;
            h = idDim.h;
        } else if (ratio === '1:1') {
            const s = Math.min(w, h);
            w = s; h = s;
        } else if (ratio === '9:16') {
            w = Math.round(h * (9 / 16));
        } else if (ratio === '16:9') {
            h = Math.round(w * (9 / 16));
        }

        outCanvas.width = w;
        outCanvas.height = h;
        origCanvas.width = w;
        origCanvas.height = h;

        const outCtx = outCanvas.getContext('2d');
        const origCtx = origCanvas.getContext('2d');
        origCtx.drawImage(origImg, 0, 0, w, h);
        outCtx.clearRect(0, 0, w, h);

        // 1. Draw Backdrop
        if (idMode && backdrop.type === 'checker') {
            outCtx.fillStyle = '#ffffff';
            outCtx.fillRect(0, 0, w, h);
        } else if (backdrop.type === 'color') {
            outCtx.fillStyle = backdrop.color;
            outCtx.fillRect(0, 0, w, h);
        } else if (backdrop.type === 'blur') {
            outCtx.save();
            outCtx.filter = 'blur(22px)';
            outCtx.drawImage(origImg, -20, -20, w + 40, h + 40);
            outCtx.restore();
        } else if (backdrop.type === 'image' && customBgImgRef.current) {
            outCtx.drawImage(customBgImgRef.current, 0, 0, w, h);
        }

        // 2. Build Cutout In-Memory
        const origW = origImg.naturalWidth;
        const origH = origImg.naturalHeight;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = origW;
        tempCanvas.height = origH;
        const tCtx = tempCanvas.getContext('2d');
        tCtx.drawImage(origImg, 0, 0);

        const imgData = tCtx.getImageData(0, 0, origW, origH);
        for (let i = 0; i < rawMask.length; i++) {
            imgData.data[i * 4 + 3] = rawMask[i];
        }
        tCtx.putImageData(imgData, 0, 0);

        // 3. Render Subject with Pan, Zoom, Rotation
        outCtx.save();
        outCtx.translate(w / 2 + transform.x, h / 2 + transform.y);
        outCtx.rotate((transform.rotation * Math.PI) / 180);
        outCtx.scale(transform.scale, transform.scale);

        let baseW = origW;
        let baseH = origH;
        if (idMode) {
            const coverScale = Math.max(w / origW, h / origH);
            baseW = origW * coverScale;
            baseH = origH * coverScale;
        }

        // Sticker Outline
        if (stickerEnabled) {
            const dCanvas = document.createElement('canvas');
            dCanvas.width = origW;
            dCanvas.height = origH;
            const dCtx = dCanvas.getContext('2d');

            for (let angle = 0; angle < 360; angle += 30) {
                const rad = (angle * Math.PI) / 180;
                dCtx.drawImage(tempCanvas, Math.cos(rad) * stickerWidth, Math.sin(rad) * stickerWidth);
            }
            dCtx.globalCompositeOperation = 'source-in';
            dCtx.fillStyle = stickerColor;
            dCtx.fillRect(0, 0, origW, origH);

            if (stickerShadow) {
                outCtx.shadowColor = 'rgba(0,0,0,0.45)';
                outCtx.shadowBlur = 15;
                outCtx.shadowOffsetY = 8;
            }
            outCtx.drawImage(dCanvas, -baseW / 2, -baseH / 2, baseW, baseH);
            outCtx.shadowColor = 'transparent';
        }

        outCtx.drawImage(tempCanvas, -baseW / 2, -baseH / 2, baseW, baseH);
        outCtx.restore();

        // 4. Render 100% Width Bottom-Anchored Nametag Banner
        if (idMode && nametagEnabled) {
            const name = nametagText.trim().toUpperCase();
            const sub = nametagSubtext.trim().toUpperCase();

            if (name || sub) {
                outCtx.save();
                const tagHeight = Math.round(h * (nametagHeightPct / 100));
                const tagY = h - tagHeight;

                outCtx.fillStyle = nametagBg;
                outCtx.fillRect(0, tagY, w, tagHeight);

                outCtx.beginPath();
                outCtx.moveTo(0, tagY);
                outCtx.lineTo(w, tagY);
                outCtx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
                outCtx.lineWidth = 1.5;
                outCtx.stroke();

                outCtx.fillStyle = nametagColor;
                outCtx.textAlign = 'center';
                outCtx.textBaseline = 'middle';

    if (sub) {
        outCtx.font = `bold ${Math.round(tagHeight * 0.38)}px Arial, sans-serif`;
        outCtx.fillText(name, w / 2, tagY + tagHeight * 0.36);

        outCtx.font = `600 ${Math.round(tagHeight * 0.22)}px Arial, sans-serif`;
        outCtx.globalAlpha = 0.85;
        outCtx.fillText(sub, w / 2, tagY + tagHeight * 0.72);
    } else {
        outCtx.font = `bold ${Math.round(tagHeight * 0.48)}px Arial, sans-serif`;
        outCtx.fillText(name, w / 2, tagY + tagHeight / 2);
    }
    outCtx.restore();
            }
        }
    }, [idMode, idDim, ratio, backdrop, transform, stickerEnabled, stickerWidth, stickerColor, stickerShadow, nametagEnabled, nametagText, nametagSubtext, nametagBg, nametagColor, nametagHeightPct]);

    useEffect(() => {
        if (hasImage) renderComposite();
    }, [hasImage, renderComposite]);

        // Process File
        const processFile = async (file) => {
            try {
                setIsLoading(true);
                setStatusText('Segmenting foreground with AI...');
                setProgress(50);

                await loadModel();

                const imgURL = URL.createObjectURL(file);
                const rawImg = await RawImage.fromURL(imgURL);

                const { pixel_values } = await processorRef.current(rawImg);
                const { output } = await modelRef.current({ input: pixel_values });

                const mask = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(rawImg.width, rawImg.height);
                rawMaskRef.current = new Uint8ClampedArray(mask.data);

                undoStackRef.current = [];
                redoStackRef.current = [];
                setCanUndo(false);
                setCanRedo(false);
                setTransform({ x: 0, y: 0, scale: 1, rotation: 0 });

                const img = new Image();
                img.src = imgURL;
                await new Promise((r) => (img.onload = r));
                origImgRef.current = img;

                setIsLoading(false);
                setHasImage(true);
                setSplitPct(50);
            } catch (err) {
                console.error(err);
                setStatusText('Error: ' + err.message);
            }
        };

        // Undo / Redo Handlers
        const saveHistoryState = () => {
            if (!rawMaskRef.current) return;
            undoStackRef.current.push(new Uint8ClampedArray(rawMaskRef.current));
            if (undoStackRef.current.length > 20) undoStackRef.current.shift();
            redoStackRef.current = [];
            setCanUndo(undoStackRef.current.length > 0);
            setCanRedo(false);
        };

        const handleUndo = useCallback(() => {
            if (!undoStackRef.current.length) return;
            redoStackRef.current.push(new Uint8ClampedArray(rawMaskRef.current));
            rawMaskRef.current.set(undoStackRef.current.pop());
            setCanUndo(undoStackRef.current.length > 0);
            setCanRedo(true);
            renderComposite();
        }, [renderComposite]);

        const handleRedo = useCallback(() => {
            if (!redoStackRef.current.length) return;
            undoStackRef.current.push(new Uint8ClampedArray(rawMaskRef.current));
            rawMaskRef.current.set(redoStackRef.current.pop());
            setCanUndo(true);
            setCanRedo(redoStackRef.current.length > 0);
            renderComposite();
        }, [renderComposite]);

        // Global Keyboard Shortcuts & Clipboard Paste
        useEffect(() => {
            const onKeyDown = (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                    e.preventDefault();
                    e.shiftKey ? handleRedo() : handleUndo();
                } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                    e.preventDefault();
                    handleRedo();
                }
            };
            const onPaste = (e) => {
                const items = (e.clipboardData || e.originalEvent.clipboardData).items;
                for (const item of items) {
                    if (item.kind === 'file' && item.type.startsWith('image/')) {
                        processFile(item.getAsFile());
                        break;
                    }
                }
            };
            window.addEventListener('keydown', onKeyDown);
            window.addEventListener('paste', onPaste);
            return () => {
                window.removeEventListener('keydown', onKeyDown);
                window.removeEventListener('paste', onPaste);
            };
        }, [handleUndo, handleRedo]);

        // Brush Paint Helper
        const applyBrush = (e) => {
            const outCanvas = outputCanvasRef.current;
            const rawMask = rawMaskRef.current;
            const origImg = origImgRef.current;
            if (!outCanvas || !rawMask || !origImg) return;

            const rect = outCanvas.getBoundingClientRect();
            const scaleX = origImg.naturalWidth / rect.width;
            const scaleY = origImg.naturalHeight / rect.height;
            const x = Math.round((e.clientX - rect.left) * scaleX);
            const y = Math.round((e.clientY - rect.top) * scaleY);
            const alphaVal = brushMode === 'restore' ? 255 : 0;

            const w = origImg.naturalWidth;
            const h = origImg.naturalHeight;

            for (let dy = -brushSize; dy <= brushSize; dy++) {
                for (let dx = -brushSize; dx <= brushSize; dx++) {
                    if (dx * dx + dy * dy <= brushSize * brushSize) {
                        const px = x + dx;
                        const py = y + dy;
                        if (px >= 0 && px < w && py >= 0 && py < h) {
                            rawMask[py * w + px] = alphaVal;
                        }
                    }
                }
            }
            renderComposite();
        };

        // Mouse Events on Canvas Stage
        const handleMouseDown = (e) => {
            if (activeTool === 'move') {
                isPanningRef.current = true;
                panStartRef.current = { x: e.clientX - transform.x, y: e.clientY - transform.y };
            } else if (activeTool === 'brush') {
                saveHistoryState();
                isPaintingRef.current = true;
                applyBrush(e);
            }
        };

        const handleMouseMove = (e) => {
            if (activeTool === 'move' && isPanningRef.current) {
                setTransform((prev) => ({
                    ...prev,
                    x: e.clientX - panStartRef.current.x,
                    y: e.clientY - panStartRef.current.y
                }));
            } else if (activeTool === 'brush' && isPaintingRef.current) {
                applyBrush(e);
            } else if (activeTool === 'compare' && isDraggingSplitRef.current && renderWrapperRef.current) {
                const rect = renderWrapperRef.current.getBoundingClientRect();
                const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
                setSplitPct(pct);
            }
        };

        const handleMouseUp = () => {
            isPanningRef.current = false;
            isPaintingRef.current = false;
            isDraggingSplitRef.current = false;
        };

        // Batch Handler
        const handleFileUpload = (e) => {
            const files = Array.from(e.target.files || []);
            if (!files.length) return;
            if (files.length === 1) {
                processFile(files[0]);
            } else {
                setBatchQueue(files.map((f) => ({ file: f, url: URL.createObjectURL(f), processed: false, blob: null })));
                setShowBatch(true);
                processFile(files[0]);
            }
        };

        const processBatchAll = async () => {
            setIsBatchProcessing(true);
            await loadModel();
            const updated = [...batchQueue];

            for (let i = 0; i < updated.length; i++) {
                if (!updated[i].processed) {
                    const rawImg = await RawImage.fromURL(updated[i].url);
                    const { pixel_values } = await processorRef.current(rawImg);
                    const { output } = await modelRef.current({ input: pixel_values });
                    const mask = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(rawImg.width, rawImg.height);

                    const c = document.createElement('canvas');
                    c.width = rawImg.width;
                    c.height = rawImg.height;
                    const cx = c.getContext('2d');
                    const tImg = new Image();
                    tImg.src = updated[i].url;
                    await new Promise((r) => (tImg.onload = r));
                    cx.drawImage(tImg, 0, 0);

                    const idata = cx.getImageData(0, 0, c.width, c.height);
                    for (let m = 0; m < mask.data.length; m++) idata.data[m * 4 + 3] = mask.data[m];
                    cx.putImageData(idata, 0, 0);

                    updated[i].blob = await new Promise((r) => c.toBlob(r, 'image/png'));
                    updated[i].processed = true;
                    setBatchQueue([...updated]);
                }
            }
            setIsBatchProcessing(false);
        };

        const downloadBatchZip = async () => {
            const zip = new JSZip();
            batchQueue.forEach((item, idx) => {
                if (item.blob) zip.file(`cutout_${idx + 1}.png`, item.blob);
            });
            const content = await zip.generateAsync({ type: 'blob' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = 'cleancut_batch.zip';
            a.click();
        };

        const downloadArtwork = () => {
            if (!outputCanvasRef.current) return;
            const a = document.createElement('a');
            a.download = idMode ? 'id-photo.png' : 'cleancut-artwork.png';
            a.href = outputCanvasRef.current.toDataURL('image/png');
            a.click();
        };

        return (
            <div
            className="bg-slate-950 text-slate-100 min-h-screen flex flex-col font-sans selection:bg-indigo-500 selection:text-white"
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            >
            {/* Header */}
            <header className="border-b border-slate-800 bg-slate-900/70 backdrop-blur sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
            <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
            <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-white via-indigo-200 to-slate-400 bg-clip-text text-transparent">
            CleanCut Studio
            </span>
            <span className="text-[10px] px-2 py-0.5 ml-2 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium uppercase tracking-wide">
            React + Tailwind v4
            </span>
            </div>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="hidden sm:inline bg-slate-800/80 px-2.5 py-1 rounded-md border border-slate-700">
            Paste anywhere: <kbd className="font-mono text-slate-300">Ctrl+V</kbd>
            </span>
            <button
            onClick={() => setShowBatch(!showBatch)}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition flex items-center gap-1.5 cursor-pointer"
            >
            <Layers className="w-3.5 h-3.5" />
            <span>Batch Queue</span>
            {batchQueue.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-indigo-500 text-[10px] text-white font-bold">
                {batchQueue.length}
                </span>
            )}
            </button>
            </div>
            </div>
            </header>

            <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-6">
            {/* Drop Zone */}
            {!hasImage && !isLoading && (
                <div className="relative group border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-3xl p-10 sm:p-14 text-center transition-all bg-slate-900/40 hover:bg-slate-900/70 cursor-pointer">
                <input
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <div className="flex flex-col items-center pointer-events-none">
                <div className="w-16 h-16 mb-4 rounded-2xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                <Wand2 className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-bold text-white mb-1">Drop one or multiple images here</h3>
                <p className="text-sm text-slate-400 max-w-md">
                Or browse files / paste directly from clipboard. Create cutouts or official Passport/ID photos.
                </p>
                </div>
                </div>
            )}

            {/* Loading Card */}
            {isLoading && (
                <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 flex flex-col gap-3">
                <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-3">
                <Loader className="w-5 h-5 animate-spin text-indigo-400" />
                <span className="text-slate-300 font-medium">{statusText}</span>
                </div>
                <span className="text-xs font-mono text-indigo-400">{progress}%</span>
                </div>
                <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                <div
                className="bg-gradient-to-r from-indigo-500 to-pink-500 h-full transition-all duration-300"
                style={{ width: `${progress}%` }}
                />
                </div>
                </div>
            )}

            {/* Batch Drawer */}
            {showBatch && (
                <div className="flex flex-col gap-3 p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold flex items-center gap-2 text-slate-200">
                <Archive className="w-4 h-4 text-indigo-400" /> Batch Queue
                </h4>
                <div className="flex items-center gap-2">
                <button
                onClick={processBatchAll}
                disabled={isBatchProcessing}
                className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 font-medium rounded-lg transition disabled:opacity-50"
                >
                {isBatchProcessing ? 'Processing...' : 'Process All'}
                </button>
                <button
                onClick={downloadBatchZip}
                disabled={!batchQueue.some((i) => i.processed)}
                className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 font-medium rounded-lg transition disabled:opacity-50"
                >
                Download ZIP
                </button>
                </div>
                </div>
                <div className="flex gap-3 overflow-x-auto py-2 custom-scroll min-h-[90px] items-center">
                {batchQueue.map((item, idx) => (
                    <div
                    key={idx}
                    onClick={() => processFile(item.file)}
                    className={`w-16 h-16 rounded-xl border flex-shrink-0 relative overflow-hidden cursor-pointer ${
                        item.processed ? 'border-emerald-500' : 'border-slate-700'
                    }`}
                    >
                    <img src={item.url} alt="" className="w-full h-full object-cover" />
                    {item.processed && (
                        <div className="absolute inset-0 bg-emerald-500/20 flex items-center justify-center text-white">
                        <Check className="w-4 h-4" />
                        </div>
                    )}
                    </div>
                ))}
                </div>
                </div>
            )}

            {/* Studio Workspace */}
            {hasImage && !isLoading && (
                <div className="flex flex-col lg:flex-row gap-6">
                {/* Center Stage */}
                <div className="flex-1 flex flex-col gap-3">
                {/* Top Canvas Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-2 p-2 bg-slate-900/90 border border-slate-800 rounded-xl">
                <div className="flex items-center gap-1.5">
                {[
                    { id: 'move', label: 'Move & Adjust', Icon: Move },
                    { id: 'compare', label: 'Split View', Icon: Split },
                    { id: 'brush', label: 'Brush Touch-up', Icon: Paintbrush }
                ].map(({ id, label, Icon }) => (
                    <button
                    key={id}
                    onClick={() => setActiveTool(id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer transition ${
                        activeTool === id
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                    }`}
                    >
                    <Icon className="w-3.5 h-3.5" /> {label}
                    </button>
                ))}
                </div>

                {/* Brush Controls + Undo/Redo */}
                {activeTool === 'brush' && (
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                    <div className="flex items-center gap-2 bg-slate-800/80 px-2.5 py-1 rounded-lg border border-slate-700">
                    <label className="flex items-center gap-1 cursor-pointer">
                    <input
                    type="radio"
                    checked={brushMode === 'erase'}
                    onChange={() => setBrushMode('erase')}
                    />{' '}
                    Erase
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                    <input
                    type="radio"
                    checked={brushMode === 'restore'}
                    onChange={() => setBrushMode('restore')}
                    />{' '}
                    Restore
                    </label>
                    </div>

                    <div className="flex items-center gap-1.5 bg-slate-800/80 px-2.5 py-1 rounded-lg border border-slate-700">
                    <span className="text-slate-400">Size:</span>
                    <input
                    type="range"
                    min="5"
                    max="80"
                    value={brushSize}
                    onChange={(e) => setBrushSize( parseInt(e.target.value) )}
                    className="w-20 accent-indigo-500 cursor-pointer"
                    />
                    </div>

                    <div className="flex items-center gap-1">
                    <button
                    onClick={handleUndo}
                    disabled={!canUndo}
                    title="Undo (Ctrl+Z)"
                    className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
                    >
                    <Undo2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                    onClick={handleRedo}
                    disabled={!canRedo}
                    title="Redo (Ctrl+Y)"
                    className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
                    >
                    <Redo2 className="w-3.5 h-3.5" />
                    </button>
                    </div>
                    </div>
                )}

                {/* Aspect Ratio Buttons */}
                <div className="flex items-center gap-1 text-xs">
                <span className="text-slate-400 mr-1 hidden sm:inline">Ratio:</span>
                {['orig', '1:1', '9:16', '16:9'].map((r) => (
                    <button
                    key={r}
                    onClick={() => setRatio(r)}
                    className={`px-2 py-1 rounded font-mono cursor-pointer ${
                        ratio === r ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                    >
                    {r === 'orig' ? 'Orig' : r}
                    </button>
                ))}
                </div>
                </div>

                {/* Interactive Canvas Container */}
                <div className="relative bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-center p-4 min-h-[460px] max-h-[640px] overflow-hidden select-none">
                <div
                ref={renderWrapperRef}
                onMouseDown={handleMouseDown}
                className={`relative rounded-xl overflow-hidden shadow-2xl flex items-center justify-center ${
                    !idMode && backdrop.type === 'checker' ? 'checkerboard' : ''
                } ${
                    activeTool === 'move'
                    ? 'cursor-grab active:cursor-grabbing'
                    : activeTool === 'brush'
                    ? 'cursor-crosshair'
                    : 'cursor-default'
                }`}
                >
                <canvas ref={outputCanvasRef} className="max-w-full max-h-[580px] object-contain block" />

                {/* Split Comparison Overlay */}
                <div
                className={`${
                    activeTool === 'compare' ? 'block' : 'hidden'
                } absolute inset-0 overflow-hidden pointer-events-none`}
                style={{ width: `${splitPct}%` }}
                >
                <canvas ref={origCanvasRef} className="max-w-full max-h-[580px] object-contain block" />
                </div>

                {/* Split Handle */}
                {activeTool === 'compare' && (
                    <div
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        isDraggingSplitRef.current = true;
                    }}
                    style={{ left: `${splitPct}%` }}
                    className="absolute top-0 bottom-0 w-1 bg-white cursor-ew-resize flex items-center justify-center pointer-events-auto shadow-2xl z-20"
                    >
                    <div className="w-7 h-7 bg-white text-slate-900 rounded-full flex items-center justify-center shadow-lg border border-slate-300">
                    <ChevronsLeftRight className="w-4 h-4" />
                    </div>
                    </div>
                )}
                </div>
                </div>
                </div>

                {/* Right Sidebar Controls */}
                <div className="w-full lg:w-84 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 flex flex-col gap-5 custom-scroll overflow-y-auto max-h-[750px]">
                {/* Passport / ID Mode Card (Collapsible) */}
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5">
                <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
                <Contact className="w-4 h-4" />
                </div>
                <div>
                <h4 className="text-xs font-bold text-slate-200">Passport / ID Mode</h4>
                <p className="text-[10px] text-slate-500">Official standard sizes & nametag</p>
                </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                <input
                type="checkbox"
                checked={idMode}
                onChange={(e) => setIdMode(e.target.checked)}
                className="sr-only peer"
                />
                <div className="w-9 h-5 bg-slate-800 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600" />
                </label>
                </div>

                {/* Only visible when ID Mode is ON */}
                {idMode && (
                    <div className="mt-3.5 pt-3.5 border-t border-slate-800/80 space-y-3.5 text-xs">
                    <div>
                    <span className="text-slate-400 block mb-1.5 font-medium">Standard Dimensions:</span>
                    <div className="grid grid-cols-2 gap-1.5">
                    {[
                        { w: 600, h: 600, label: '2x2 in (US/PH)' },
                            { w: 413, h: 531, label: '35x45mm (Passport)' },
                            { w: 300, h: 300, label: '1x1 inch' },
                            { w: 600, h: 300, label: '2x1 inch' }
                    ].map((preset) => (
                        <button
                        key={preset.label}
                        onClick={() => setIdDim(preset)}
                        className={`px-2 py-1.5 rounded-lg font-medium text-center truncate cursor-pointer ${
                            idDim.label === preset.label
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                        }`}
                        >
                        {preset.label}
                        </button>
                    ))}
                    </div>
                    </div>

                    {/* Bottom 100% Width Nametag */}
                    <div className="border-t border-slate-800/80 pt-3">
                    <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-slate-300">Bottom 100% Nametag</span>
                    <input
                    type="checkbox"
                    checked={nametagEnabled}
                    onChange={(e) => setNametagEnabled(e.target.checked)}
                    className="w-3.5 h-3.5 rounded text-indigo-600 cursor-pointer"
                    />
                    </div>

                    {nametagEnabled && (
                        <div className="space-y-2">
                        <input
                        type="text"
                        value={nametagText}
                        onChange={(e) => setNametagText(e.target.value)}
                        placeholder="FIRSTNAME M. LASTNAME"
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white uppercase tracking-wider focus:border-indigo-500 focus:outline-none"
                        />
                        <input
                        type="text"
                        value={nametagSubtext}
                        onChange={(e) => setNametagSubtext(e.target.value)}
                        placeholder="Optional: ID / POSITION / DEPT"
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-[11px] text-slate-300 uppercase tracking-wide focus:border-indigo-500 focus:outline-none"
                        />

                        <div className="grid grid-cols-2 gap-2 pt-1">
                        <div className="flex items-center justify-between bg-slate-900 px-2.5 py-1 rounded border border-slate-800">
                        <span className="text-slate-400 text-[11px]">Tag BG</span>
                        <input
                        type="color"
                        value={nametagBg}
                        onChange={(e) => setNametagBg(e.target.value)}
                        className="w-5 h-5 bg-transparent cursor-pointer"
                        />
                        </div>
                        <div className="flex items-center justify-between bg-slate-900 px-2.5 py-1 rounded border border-slate-800">
                        <span className="text-slate-400 text-[11px]">Text Color</span>
                        <input
                        type="color"
                        value={nametagColor}
                        onChange={(e) => setNametagColor(e.target.value)}
                        className="w-5 h-5 bg-transparent cursor-pointer"
                        />
                        </div>
                        </div>

                        <div className="flex items-center justify-between pt-1">
                        <span className="text-slate-400 text-[11px]">Banner Height</span>
                        <div className="flex items-center gap-1.5">
                        <input
                        type="range"
                        min="10"
                        max="25"
                        value={nametagHeightPct}
                        onChange={(e) => setNametagHeightPct(parseInt(e.target.value))}
                        className="w-20 accent-indigo-500 cursor-pointer"
                        />
                        <span className="font-mono text-[10px] text-slate-400 w-6 text-right">
                        {nametagHeightPct}%
                        </span>
                        </div>
                        </div>
                        </div>
                    )}
                    </div>
                    </div>
                )}
                </div>

                {/* Subject Adjustments */}
                <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-indigo-400" /> Subject Adjustments
                </h4>
                <button
                onClick={() => setTransform({ x: 0, y: 0, scale: 1, rotation: 0 })}
                className="text-[10px] text-indigo-400 hover:text-indigo-300 cursor-pointer"
                >
                Reset
                </button>
                </div>
                <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                <span className="text-slate-400">Scale / Zoom</span>
                <div className="flex items-center gap-2">
                <input
                type="range"
                min="0.5"
                max="2.5"
                step="0.05"
                value={transform.scale}
                onChange={(e) => setTransform({ ...transform, scale: parseFloat(e.target.value) })}
                className="w-24 accent-indigo-500 cursor-pointer"
                />
                <span className="font-mono text-slate-300 text-[10px] w-8 text-right">
                {transform.scale.toFixed(2)}x
                </span>
                </div>
                </div>
                <div className="flex items-center justify-between">
                <span className="text-slate-400">Rotate</span>
                <div className="flex items-center gap-2">
                <input
                type="range"
                min="-180"
                max="180"
                step="1"
                value={transform.rotation}
                onChange={(e) => setTransform({ ...transform, rotation: parseInt(e.target.value) })}
                className="w-24 accent-indigo-500 cursor-pointer"
                />
                <span className="font-mono text-slate-300 text-[10px] w-8 text-right">
                {transform.rotation}°
                </span>
                </div>
                </div>
                <p className="text-[10px] text-slate-500 italic pt-1">
                Click & drag the subject on the canvas to pan/reposition.
                </p>
                </div>
                </div>

                {/* Backdrop Presets */}
                <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Backdrop Preset</h4>
                <div className="grid grid-cols-5 gap-2 mb-2.5">
                <button
                onClick={() => setBackdrop({ type: 'checker' })}
                className="h-8 rounded-lg border border-slate-700 checkerboard hover:ring-2 hover:ring-indigo-500 cursor-pointer"
                title="Transparent"
                />
                {[
                    { color: '#ffffff', title: 'White' },
                    { color: '#1d4ed8', title: 'Passport Royal Blue' },
                    { color: '#b91c1c', title: 'Passport Red' },
                    { color: '#020617', title: 'Onyx Dark' }
                ].map((b) => (
                    <button
                    key={b.color}
                    onClick={() => setBackdrop({ type: 'color', color: b.color })}
                    style={{ backgroundColor: b.color }}
                    className="h-8 rounded-lg border border-slate-700 hover:ring-2 hover:ring-indigo-500 cursor-pointer"
                    title={b.title}
                    />
                ))}
                </div>
                <div className="flex items-center gap-2">
                <button
                onClick={() => setBackdrop({ type: 'blur' })}
                className="text-xs py-1.5 px-3 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 flex-1 flex items-center justify-center gap-1 cursor-pointer"
                >
                <Aperture className="w-3.5 h-3.5 text-indigo-400" /> Bokeh Blur
                </button>
                <label className="cursor-pointer text-xs py-1.5 px-3 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center gap-1">
                <ImageIcon className="w-3.5 h-3.5 text-pink-400" /> Custom BG
                <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                    if (e.target.files?.[0]) {
                        const img = new Image();
                        img.src = URL.createObjectURL(e.target.files[0]);
                        img.onload = () => {
                            customBgImgRef.current = img;
                            setBackdrop({ type: 'image' });
                        };
                    }
                }}
                className="hidden"
                />
                </label>
                </div>
                </div>

                {/* Sticker Mode */}
                <div className="border-t border-slate-800 pt-4">
                <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Sticker Mode</h4>
                <input
                type="checkbox"
                checked={stickerEnabled}
                onChange={(e) => setStickerEnabled(e.target.checked)}
                className="w-4 h-4 rounded text-indigo-600 cursor-pointer"
                />
                </div>
                {stickerEnabled && (
                    <div className="space-y-2.5 text-xs">
                    <div className="flex items-center justify-between">
                    <span className="text-slate-400">Border Width</span>
                    <input
                    type="range"
                    min="2"
                    max="30"
                    value={stickerWidth}
                    onChange={(e) => setStickerWidth(parseInt(e.target.value))}
                    className="w-24 accent-indigo-500"
                    />
                    </div>
                    <div className="flex items-center justify-between">
                    <span className="text-slate-400">Border Color</span>
                    <input
                    type="color"
                    value={stickerColor}
                    onChange={(e) => setStickerColor(e.target.value)}
                    className="w-6 h-6 bg-transparent cursor-pointer"
                    />
                    </div>
                    <div className="flex items-center justify-between">
                    <span className="text-slate-400">Drop Shadow</span>
                    <input
                    type="checkbox"
                    checked={stickerShadow}
                    onChange={(e) => setStickerShadow(e.target.checked)}
                    className="w-4 h-4 rounded text-indigo-600"
                    />
                    </div>
                    </div>
                )}
                </div>

                {/* Export Actions */}
                <div className="border-t border-slate-800 pt-4 flex flex-col gap-2.5">
                <button
                onClick={downloadArtwork}
                className="w-full py-3 px-4 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-medium rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/30 transition cursor-pointer"
                >
                <Download className="w-4 h-4" />
                <span>{idMode ? 'Export ID Photo (PNG)' : 'Export Artwork (PNG)'}</span>
                </button>
                <button
                onClick={() => setHasImage(false)}
                className="w-full py-2 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition cursor-pointer"
                >
                Start Over
                </button>
                </div>
                </div>
                </div>
            )}
            </main>
            </div>
        );
}
