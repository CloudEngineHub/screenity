// Lazy-load @mediapipe/tasks-vision; ~133KB of code only needed when
// the user enables background effects on the camera. Eager import was
// adding the cost to every camera-bubble mount even for users who
// never touch effects.
let _mpPromise = null;
const loadMediapipe = () => {
  if (!_mpPromise) {
    _mpPromise = import("@mediapipe/tasks-vision");
  }
  return _mpPromise;
};

// Reused across frames to avoid GC pressure.
let _frameCanvas = null;
let _frameCtx = null;
let _blurCanvas = null;
let _blurCtx = null;
let _maskCanvas = null;
let _maskCtx = null;
let _smoothMaskCanvas = null;
let _smoothMaskCtx = null;
let _personCanvas = null;
let _personCtx = null;

function getReusableCanvases() {
  if (!_frameCanvas) {
    _frameCanvas = document.createElement("canvas");
    _frameCtx = _frameCanvas.getContext("2d");
    _blurCanvas = document.createElement("canvas");
    _blurCtx = _blurCanvas.getContext("2d");
    _maskCanvas = document.createElement("canvas");
    _maskCtx = _maskCanvas.getContext("2d");
    _smoothMaskCanvas = document.createElement("canvas");
    _smoothMaskCtx = _smoothMaskCanvas.getContext("2d");
    _personCanvas = document.createElement("canvas");
    _personCtx = _personCanvas.getContext("2d");
  }
  return {
    frameCanvas: _frameCanvas, frameCtx: _frameCtx,
    blurCanvas: _blurCanvas, blurCtx: _blurCtx,
    maskCanvas: _maskCanvas, maskCtx: _maskCtx,
    smoothMaskCanvas: _smoothMaskCanvas, smoothMaskCtx: _smoothMaskCtx,
    personCanvas: _personCanvas, personCtx: _personCtx,
  };
}

let _maskImageDataCache = null;

function getOrCreateMaskImageData(ctx, width, height) {
  if (
    _maskImageDataCache &&
    _maskImageDataCache.width === width &&
    _maskImageDataCache.height === height
  ) {
    return _maskImageDataCache;
  }
  _maskImageDataCache = ctx.createImageData(width, height);
  return _maskImageDataCache;
}

// Bound the model load; MediaPipe's wasm/tflite fetch can hang on flaky
// networks, blocked CDNs, or corrupted bundles.
const MODEL_LOAD_TIMEOUT_MS = 12000;

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}-timeout-${ms}ms`)), ms),
    ),
  ]);

const tryCreateSegmenter = async (vision, delegate) => {
  const { ImageSegmenter } = await loadMediapipe();
  return ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "./assets/mediapipeVision/selfie_segmenter.tflite",
      delegate,
    },
    outputCategoryMask: false,
    outputConfidenceMasks: true,
    runningMode: "VIDEO",
  });
};

export const loadSegmentationModel = async () => {
  try {
    const { FilesetResolver } = await loadMediapipe();
    const vision = await withTimeout(
      FilesetResolver.forVisionTasks("./assets/mediapipeVision"),
      MODEL_LOAD_TIMEOUT_MS,
      "fileset-resolver",
    );

    // GPU path; fall back to CPU on systems without WebGL2 or with bad
    // GPU drivers (old Intel iGPUs, Linux, some VMs).
    try {
      const gpu = await withTimeout(
        tryCreateSegmenter(vision, "GPU"),
        MODEL_LOAD_TIMEOUT_MS,
        "segmenter-gpu",
      );
      try {
        chrome.runtime.sendMessage({
          type: "diag-forward",
          event: "recorder-segmenter-loaded",
          data: { delegate: "GPU" },
        });
      } catch {}
      return gpu;
    } catch (gpuErr) {
      console.warn(
        "[Screenity] GPU segmenter failed, falling back to CPU:",
        gpuErr,
      );
      try {
        chrome.runtime.sendMessage({
          type: "diag-forward",
          event: "recorder-segmenter-gpu-fallback",
          data: { error: String(gpuErr?.message || gpuErr).slice(0, 200) },
        });
      } catch {}
      const cpu = await withTimeout(
        tryCreateSegmenter(vision, "CPU"),
        MODEL_LOAD_TIMEOUT_MS,
        "segmenter-cpu",
      );
      try {
        chrome.runtime.sendMessage({
          type: "diag-forward",
          event: "recorder-segmenter-loaded",
          data: { delegate: "CPU" },
        });
      } catch {}
      return cpu;
    }
  } catch (error) {
    console.error("Error loading segmentation model:", error);
    try {
      chrome.runtime.sendMessage({
        type: "diag-forward",
        event: "recorder-segmenter-load-failed",
        data: { error: String(error?.message || error).slice(0, 200) },
      });
    } catch {}
    return null;
  }
};

// The model runs at 256px; a full-res input only enlarges the slow mask readback.
const SEGMENT_INPUT_WIDTH = 256;
let _segInputCanvas = null;
let _segInputCtx = null;

// The mask is only valid inside the callback, so copy it out there.
let _maskCopy = null;

export const segmentFromVideo = (videoElement, segmenter) => {
  if (!videoElement || !segmenter) return null;
  if (videoElement.readyState < 2 || videoElement.videoWidth === 0) return null;

  try {
    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;
    const inW = Math.min(vw, SEGMENT_INPUT_WIDTH);
    const inH = Math.max(1, Math.round((inW * vh) / vw));

    if (!_segInputCanvas) {
      _segInputCanvas = document.createElement("canvas");
      _segInputCtx = _segInputCanvas.getContext("2d");
    }
    if (_segInputCanvas.width !== inW || _segInputCanvas.height !== inH) {
      _segInputCanvas.width = inW;
      _segInputCanvas.height = inH;
    }
    _segInputCtx.drawImage(videoElement, 0, 0, inW, inH);

    const timestampMs = performance.now();
    let result = null;

    segmenter.segmentForVideo(_segInputCanvas, timestampMs, (r) => {
      const mask = r && r.confidenceMasks && r.confidenceMasks[0];
      if (!mask) return;
      const src = mask.getAsFloat32Array();
      if (!_maskCopy || _maskCopy.length !== src.length) {
        _maskCopy = new Float32Array(src.length);
      }
      _maskCopy.set(src);
      const copy = _maskCopy;
      result = {
        confidenceMask: {
          width: mask.width,
          height: mask.height,
          data: copy,
        },
      };
    });

    return result;
  } catch (error) {
    console.error("Error during segmentation:", error);
    return null;
  }
};

// Confidence below LOW is background, above HIGH is person; the ramp softens
// the model's blobby falloff.
const MASK_EDGE_LOW = 0.3;
const MASK_EDGE_HIGH = 0.7;
// Weight of the current frame; the rest is the previous one, which stops edge shimmer.
const MASK_TEMPORAL_WEIGHT = 0.6;

let _prevAlpha = null;

function buildSmoothedMask(segmentationResult, edgeBlurAmount, personOpaque, videoWidth) {
  const mask = segmentationResult.confidenceMask;
  const conf = mask.data;
  const maskW = mask.width;
  const maskH = mask.height;

  const { maskCanvas, maskCtx, smoothMaskCanvas, smoothMaskCtx } = getReusableCanvases();

  if (maskCanvas.width !== maskW || maskCanvas.height !== maskH) {
    maskCanvas.width = maskW;
    maskCanvas.height = maskH;
    smoothMaskCanvas.width = maskW;
    smoothMaskCanvas.height = maskH;
  }

  const maskImageData = getOrCreateMaskImageData(maskCtx, maskW, maskH);
  const maskPixels = new Uint32Array(maskImageData.data.buffer);

  if (!_prevAlpha || _prevAlpha.length !== conf.length) {
    _prevAlpha = new Float32Array(conf.length);
    _prevAlpha.set(conf);
  }

  const range = MASK_EDGE_HIGH - MASK_EDGE_LOW;
  for (let i = 0; i < conf.length; i++) {
    let t = (conf[i] - MASK_EDGE_LOW) / range;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const target = t * t * (3 - 2 * t);
    const alpha =
      _prevAlpha[i] + (target - _prevAlpha[i]) * MASK_TEMPORAL_WEIGHT;
    _prevAlpha[i] = alpha;
    const a = Math.round(alpha * 255);
    // Little-endian RGBA: white for person-opaque, black for destination-out.
    maskPixels[i] = personOpaque
      ? ((a << 24) | 0x00ffffff) >>> 0
      : (((255 - a) << 24) >>> 0);
  }
  maskCtx.putImageData(maskImageData, 0, 0);

  smoothMaskCtx.clearRect(0, 0, maskW, maskH);
  // Edge blur is tuned in video pixels; the mask is smaller than the video.
  const edgePx = (edgeBlurAmount * maskW) / videoWidth;
  smoothMaskCtx.filter = `blur(${edgePx}px)`;
  smoothMaskCtx.drawImage(maskCanvas, 0, 0);
  smoothMaskCtx.filter = "none";

  return { smoothMaskCanvas, maskW, maskH };
}

export const renderBlurFromVideo = (videoElement, segmentationResult, canvasRef) => {
  if (!videoElement || !segmentationResult || !canvasRef.current) return false;

  try {
    const backgroundBlurAmount = 16;
    const edgeBlurAmount = 3;

    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;

    const { frameCanvas, frameCtx, blurCanvas, blurCtx, personCanvas, personCtx } =
      getReusableCanvases();

    if (frameCanvas.width !== vw || frameCanvas.height !== vh) {
      frameCanvas.width = vw;
      frameCanvas.height = vh;
      blurCanvas.width = vw;
      blurCanvas.height = vh;
    }

    frameCtx.drawImage(videoElement, 0, 0);

    blurCtx.filter = `blur(${backgroundBlurAmount}px)`;
    blurCtx.drawImage(frameCanvas, 0, 0);
    blurCtx.filter = "none";

    const { smoothMaskCanvas, maskW, maskH } =
      buildSmoothedMask(segmentationResult, edgeBlurAmount, true, vw);

    const ratio = vw / vh;
    const outW = Math.round(window.innerHeight * ratio);
    const outH = window.innerHeight;

    if (canvasRef.current.width !== outW || canvasRef.current.height !== outH) {
      canvasRef.current.width = outW;
      canvasRef.current.height = outH;
    }

    if (personCanvas.width !== outW || personCanvas.height !== outH) {
      personCanvas.width = outW;
      personCanvas.height = outH;
    }

    const outputCtx = canvasRef.current.getContext("2d");

    outputCtx.drawImage(blurCanvas, 0, 0, vw, vh, 0, 0, outW, outH);

    personCtx.clearRect(0, 0, outW, outH);
    personCtx.globalCompositeOperation = "source-over";
    personCtx.drawImage(smoothMaskCanvas, 0, 0, maskW, maskH, 0, 0, outW, outH);
    personCtx.globalCompositeOperation = "source-in";
    personCtx.drawImage(frameCanvas, 0, 0, vw, vh, 0, 0, outW, outH);

    outputCtx.drawImage(personCanvas, 0, 0);

    return true;
  } catch (error) {
    console.error("Error rendering blur:", error);
    return false;
  }
};

export const renderPersonCutoutFromVideo = (
  videoElement,
  segmentationResult,
  canvasRef,
  canvasContextRef,
) => {
  if (!videoElement || !segmentationResult || !canvasRef.current) return false;

  try {
    const edgeBlurAmount = 2;

    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;

    const { frameCanvas, frameCtx, personCanvas, personCtx } = getReusableCanvases();

    if (frameCanvas.width !== vw || frameCanvas.height !== vh) {
      frameCanvas.width = vw;
      frameCanvas.height = vh;
    }

    frameCtx.drawImage(videoElement, 0, 0);

    const { smoothMaskCanvas, maskW, maskH } =
      buildSmoothedMask(segmentationResult, edgeBlurAmount, true, vw);

    const canvas = canvasRef.current;
    const ctx = canvasContextRef.current;

    const outW = Math.round((window.innerHeight * vw) / vh);
    const outH = window.innerHeight;
    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
    }

    if (personCanvas.width !== canvas.width || personCanvas.height !== canvas.height) {
      personCanvas.width = canvas.width;
      personCanvas.height = canvas.height;
    }

    personCtx.clearRect(0, 0, canvas.width, canvas.height);
    personCtx.globalCompositeOperation = "source-over";
    personCtx.drawImage(smoothMaskCanvas, 0, 0, maskW, maskH, 0, 0, canvas.width, canvas.height);
    personCtx.globalCompositeOperation = "source-in";
    personCtx.drawImage(frameCanvas, 0, 0, vw, vh, 0, 0, canvas.width, canvas.height);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(personCanvas, 0, 0);

    return true;
  } catch (error) {
    console.error("Error rendering person cutout:", error);
    return false;
  }
};

export const loadEffect = (effectUrl) => {
  return new Promise((resolve, reject) => {
    if (!effectUrl) {
      resolve(null);
      return;
    }

    const img = new Image();
    img.src = effectUrl;
    img.onload = () => resolve(img);
    img.onerror = (error) => {
      console.error("Failed to load effect image:", error);
      reject(error);
    };
  });
};

export const renderEffectBackground = (
  effectImg,
  bottomCanvasRef,
  bottomCanvasContextRef
) => {
  if (!effectImg || !bottomCanvasRef.current || !bottomCanvasContextRef.current)
    return false;

  try {
    const canvas = bottomCanvasRef.current;
    const ctx = bottomCanvasContextRef.current;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const imgRatio = effectImg.width / effectImg.height;
    const canvasRatio = canvas.width / canvas.height;
    let drawWidth = canvas.width;
    let drawHeight = canvas.height;

    if (canvasRatio > imgRatio) {
      drawWidth = canvas.height * imgRatio;
      drawHeight = canvas.height;
    } else {
      drawWidth = canvas.width;
      drawHeight = canvas.width / imgRatio;
    }

    const x = (canvas.width - drawWidth) / 2;
    const y = (canvas.height - drawHeight) / 2;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(effectImg, x, y, drawWidth, drawHeight);

    return true;
  } catch (error) {
    console.error("Error rendering effect background:", error);
    return false;
  }
};
