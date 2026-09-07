import { useState, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { 
  LuRotate3D, 
  LuArrowLeftRight, 
  LuArrowUpDown, 
  LuClock, 
  LuFolderOpen, 
  LuExternalLink,
  LuPencil,
  LuEye
} from 'react-icons/lu';
import { FaPlay, FaPause } from 'react-icons/fa6';
import { MdDraw } from 'react-icons/md';
import ThreeVolume from './components/ThreeVolume';

// カーテンメッシュ（時間・空間スライス面）の型定義
interface CurtainData {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

// テクスチャ状態の型定義
interface TexturesState {
  front: THREE.CanvasTexture | null;
  back: THREE.CanvasTexture | null;
  left: THREE.CanvasTexture | null;
  right: THREE.CanvasTexture | null;
  top: THREE.CanvasTexture | null;
  bottom: THREE.CanvasTexture | null;
}

export default function App() {
  // --- 子ウィンドウパラメータのパース ---
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const viewMode = params.get('view');

  // --- ポップアウトウィンドウ監視ステート ---
  const [isPopoutOpen, setIsPopoutOpen] = useState<boolean>(false);
  const popoutWindowRef = useRef<Window | null>(null);

  // --- モード管理ステート ---
  const [toolMode, setToolMode] = useState<'rotate' | 'draw' | 'greasePencil'>('rotate');


  // --- 動画関連ステート ---
  const [samplingScale, setSamplingScale] = useState<number>(1.0); // x,y,z の共通縮小率
  const [videoSrc, setVideoSrc] = useState<string>('flower_02.mp4'); // 初期設定動画
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanProgressText, setScanProgressText] = useState<string>("");
  const [scanProgressPercent, setScanProgressPercent] = useState<number>(0);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(true);
  const [scanCompleted, setScanCompleted] = useState<boolean>(false);

  const [videoWidth, setVideoWidth] = useState<number>(1920);
  const [videoHeight, setVideoHeight] = useState<number>(1080);
  const [totalFrames, setTotalFrames] = useState<number>(300);
  const [scanFrames, setScanFrames] = useState<number>(75);

  // --- 3Dボリューム物理寸法 ---
  const [volW, setVolW] = useState<number>(2.0);
  const [volH, setVolH] = useState<number>(1.125);
  const [volD, setVolD] = useState<number>(3.0);
  const [volumeOpacity, setVolumeOpacity] = useState<number>(1.0);

  // --- 2D スリットスキャン動画 (24fps) アニメーションステート ---
  const [offsetVal, setOffsetVal] = useState<number>(0); // 物理移動オフセット
  const [isPlaying2D, setIsPlaying2D] = useState<boolean>(false); // 初期状態は「一時停止 (再生オフ)」にする
  const [sweepAxis, setSweepAxis] = useState<'X' | 'Y' | 'Z' | 'VIEW'>('X'); // アニメーションスイープ軸
  const [playSpeed, setPlaySpeed] = useState<number>(1.0); // 再生・移動速度倍率 (デフォルト1.0x)

  // --- HTML5 Video 要素の参照 ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const modalVideoRef = useRef<HTMLVideoElement>(null); // iPad Safari blob: URL 対策用モーダル再生動画 Ref
  const videoInputRef = useRef<HTMLInputElement>(null);

  // --- 2D スリットスキャン結果表示 Canvas 参照 ---
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // --- 軌跡ポイントおよび押し出し方向の保持用 ref (レンダリング同期なしでアニメーション内で高速アクセスするため) ---
  const lastLinePointsRef = useRef<THREE.Vector3[]>([]);
  const lastExtrudeDirectionRef = useRef<'X' | 'Y' | 'Z' | 'VIEW'>('Z');
  // ★グリースペンシル用: 視線ベクトル、カメラ位置、各ストローク点ごとのAABB交差深度の保持用 ref
  const viewDirectionRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0, 1));
  const viewDepthRangeRef = useRef<{ min: number; max: number }>({ min: -1.5, max: 1.5 });
  const cameraPositionRef = useRef<THREE.Vector3>(new THREE.Vector3(3, 3, 5));
  const pointRangesRef = useRef<Array<{ tmin: number; tmax: number; dir: THREE.Vector3 }>>([]);

  // --- スリットスキャン Canvas & Context の参照 ---
  const canvasesRef = useRef<{
    front: HTMLCanvasElement | null;
    back: HTMLCanvasElement | null;
    left: HTMLCanvasElement | null;
    right: HTMLCanvasElement | null;
    top: HTMLCanvasElement | null;
    bottom: HTMLCanvasElement | null;
  }>({ front: null, back: null, left: null, right: null, top: null, bottom: null });

  const ctxRef = useRef<{
    front: CanvasRenderingContext2D | null;
    back: CanvasRenderingContext2D | null;
    left: CanvasRenderingContext2D | null;
    right: CanvasRenderingContext2D | null;
    top: CanvasRenderingContext2D | null;
    bottom: CanvasRenderingContext2D | null;
  }>({ front: null, back: null, left: null, right: null, top: null, bottom: null });

  // --- Three.js CanvasTexture のステート & Ref (Safari非同期更新対策) ---
  const [textures, setTextures] = useState<TexturesState>({
    front: null, back: null, left: null, right: null, top: null, bottom: null
  });
  const texturesRef = useRef<TexturesState>({
    front: null, back: null, left: null, right: null, top: null, bottom: null
  });

  // --- 生成されたスライス（カーテン）メッシュ of 3D ---
  const [curtains, setCurtains] = useState<CurtainData[]>([]);

  // --- 2D プレビュー Canvas を 3D テクスチャとしてバインドするための Ref ---
  const curtainTextureRef = useRef<THREE.CanvasTexture | null>(null);
  // --- 物理オフセットのピンポンアニメーション用同期 Ref ---
  const offsetDirectionRef = useRef<number>(1); // +1: 増加方向, -1: 減少方向
  const linePointsMinMaxRef = useRef<{ min: number, max: number }>({ min: 0, max: 0 });

  // --- スキャンしたフレーム画像のキャッシュバッファ ---
  const scanFrameCanvasesRef = useRef<HTMLCanvasElement[]>([]);

  // スキャン制御用の変数
  const currentScanFrameRef = useRef<number>(0);
  const isScanningRef = useRef<boolean>(false);


  // ページタイトルの制御
  useEffect(() => {
    if (viewMode === 'preview') {
      document.title = 'timesector-ext - Preview';
    } else {
      document.title = 'timesector-ext';
    }
  }, [viewMode]);

  // キーボードショートカット (Space: 2D再生/一時停止, V: Pan/Select, D: Slice/Draw/Edit)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          activeElement.tagName === 'SELECT' ||
          (activeElement as HTMLElement).isContentEditable)
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (lastLinePointsRef.current.length >= 2) {
          setIsPlaying2D(prev => !prev);
        }
      } else if (key === 'v') {
        setToolMode('rotate');
      } else if (key === 'd') {
        setToolMode('draw');
      } else if (key === 'g') {
        setToolMode('greasePencil');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // 初回起動時に Canvas 要素を準備する
  useEffect(() => {
    canvasesRef.current = {
      front: document.createElement('canvas'),
      back: document.createElement('canvas'),
      left: document.createElement('canvas'),
      right: document.createElement('canvas'),
      top: document.createElement('canvas'),
      bottom: document.createElement('canvas')
    };

    ctxRef.current = {
      front: canvasesRef.current.front!.getContext('2d'),
      back: canvasesRef.current.back!.getContext('2d'),
      left: canvasesRef.current.left!.getContext('2d'),
      right: canvasesRef.current.right!.getContext('2d'),
      top: canvasesRef.current.top!.getContext('2d'),
      bottom: canvasesRef.current.bottom!.getContext('2d')
    };

    // 初期化テクスチャの作成
    initVolumeTextures(1920, 1080, 75);
  }, []);

  // プレビューキャンバスのマウントを確実に検知してグローバルに登録するコールバックRef
  const previewCanvasCallbackRef = (el: HTMLCanvasElement | null) => {
    (previewCanvasRef as any).current = el;
    if (el && typeof window !== 'undefined') {
      (window as any).timesectorPreviewCanvas = el;
    }
  };

  // 2D プレビュー子ウィンドウ用の描画同期
  useEffect(() => {
    if (viewMode !== 'preview' || typeof window === 'undefined' || !window.opener) return;

    let active = true;
    const canvas = previewCanvasRef.current;
    
    const syncLoop = () => {
      if (!active || !canvas) return;
      
      const parentPreviewCanvas = (window.opener as any).timesectorPreviewCanvas;

      if (parentPreviewCanvas && parentPreviewCanvas.width > 0) {
        if (canvas.width !== parentPreviewCanvas.width || canvas.height !== parentPreviewCanvas.height) {
          canvas.width = parentPreviewCanvas.width;
          canvas.height = parentPreviewCanvas.height;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(parentPreviewCanvas, 0, 0);
        }
      }

      requestAnimationFrame(syncLoop);
    };

    requestAnimationFrame(syncLoop);

    return () => {
      active = false;
    };
  }, [viewMode]);

  // ポップアウトウィンドウを開く関数
  const popoutPreview = () => {
    // 既に開いている場合はフォーカスするだけにする
    if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
      popoutWindowRef.current.focus();
      return;
    }

    const popout = window.open(
      `${window.location.origin}${window.location.pathname}?view=preview`, 
      'timesector_preview', 
      'width=800,height=600,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes'
    );
    popoutWindowRef.current = popout;
    setIsPopoutOpen(true);

    if (popout) {
      const checkClosed = setInterval(() => {
        if (!popout || popout.closed) {
          clearInterval(checkClosed);
          setIsPopoutOpen(false);
          popoutWindowRef.current = null;
        }
      }, 500);
    }
  };

  // 3D座標から動画のピクセル・フレーム座標への逆変換ヘルパー
  const getPixelCoordsLocal = (point: THREE.Vector3) => {
    const pixelX = Math.round(((point.x + volW / 2) / volW) * videoWidth);
    const pixelY = Math.round(((-point.y + volH / 2) / volH) * videoHeight);
    const frameZ = Math.round(((volD / 2 - point.z) / volD) * totalFrames);
    return {
      x: Math.max(0, Math.min(videoWidth, pixelX)),
      y: Math.max(0, Math.min(videoHeight, pixelY)),
      frame: Math.max(0, Math.min(totalFrames, frameZ))
    };
  };

  // 2D プレビューキャンバスへのリアルタイムスリットスキャンサンプリング描画関数
  const drawPreviewCanvas = (currentOffsetVal: number) => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    const N = lastLinePointsRef.current.length;
    const canvases = scanFrameCanvasesRef.current;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 軌跡がまだ描かれていない場合は透過クリア
    if (N < 2 || canvases.length === 0) {
      canvas.width = 400;
      canvas.height = 300;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const extrudeDirection = lastExtrudeDirectionRef.current;

    // ★新規: グリースペンシル (視線直交スライス) のサンプリング描画処理
    if (extrudeDirection === 'VIEW') {
      const ranges = pointRangesRef.current;
      const texW = N;
      const texH = Math.max(128, canvases.length);

      if (canvas.width !== texW || canvas.height !== texH) {
        canvas.width = texW;
        canvas.height = texH;
      }

      const imgData = ctx.createImageData(texW, texH);
      const data = imgData.data;

      const halfW = volW / 2;
      const halfH = volH / 2;
      const halfD = volD / 2;

      // ★各軸およびVIEWモードに応じた安全なクランプオフセットを計算 (ThreeVolumeのメッシュ移動と完全同期)
      const maxViewOffset = Math.max(volW, volH, volD) * 0.4;
      let safeOffset = currentOffsetVal;
      if (sweepAxis === 'VIEW') {
        safeOffset = Math.max(-maxViewOffset, Math.min(maxViewOffset, currentOffsetVal));
      } else if (sweepAxis === 'X') {
        const minVal = linePointsMinMaxRef.current.min;
        const maxVal = linePointsMinMaxRef.current.max;
        safeOffset = Math.max(-halfW - minVal, Math.min(halfW - maxVal, currentOffsetVal));
      } else if (sweepAxis === 'Y') {
        const minVal = linePointsMinMaxRef.current.min;
        const maxVal = linePointsMinMaxRef.current.max;
        safeOffset = Math.max(-halfH - minVal, Math.min(halfH - maxVal, currentOffsetVal));
      } else if (sweepAxis === 'Z') {
        const minVal = linePointsMinMaxRef.current.min;
        const maxVal = linePointsMinMaxRef.current.max;
        safeOffset = Math.max(-halfD - minVal, Math.min(halfD - maxVal, currentOffsetVal));
      }

      const mainViewDir = viewDirectionRef.current;

      for (let u = 0; u < N; u++) {
        const pt = lastLinePointsRef.current[u];
        const r = ranges[u] || { tmin: viewDepthRangeRef.current.min, tmax: viewDepthRangeRef.current.max, dir: viewDirectionRef.current };
        const tmin = r.tmin;
        const tmax = r.tmax;
        const dir = r.dir || mainViewDir;

        // 視線方向または選択された軸でのオフセット移動 (ThreeVolumeのメッシュ移動と完全同期)
        let offX = 0, offY = 0, offZ = 0;
        if (sweepAxis === 'VIEW') {
          offX = safeOffset * mainViewDir.x;
          offY = safeOffset * mainViewDir.y;
          offZ = safeOffset * mainViewDir.z;
        } else if (sweepAxis === 'X') {
          offX = safeOffset;
        } else if (sweepAxis === 'Y') {
          offY = safeOffset;
        } else if (sweepAxis === 'Z') {
          offZ = safeOffset;
        }

        for (let v = 0; v < texH; v++) {
          // v=0 が手前表面 (tmin), v=texH-1 が奥表面 (tmax) に正確に対応
          const tRatio = v / (texH - 1);
          const t = tmin + tRatio * (tmax - tmin);

          const sx = pt.x + t * dir.x + offX;
          const sy = pt.y + t * dir.y + offY;
          const sz = pt.z + t * dir.z + offZ;

          const destIdx = (v * texW + u) * 4;

          // ★端のサンプリング座標をボリューム境界内に安全にクランプ
          // これにより、カーテンがボリューム端に達しても消滅せず、端のピクセルが正しく描画され続ける
          const clampedSx = Math.max(-halfW, Math.min(halfW, sx));
          const clampedSy = Math.max(-halfH, Math.min(halfH, sy));
          const clampedSz = Math.max(-halfD, Math.min(halfD, sz));

          // 3D空間のZ座標 (clampedSz) から正確なフレーム比率を直接計算 (+halfD が手前=0、-halfD が奥=末尾)
          const frameRatio = Math.max(0, Math.min(1, (halfD - clampedSz) / volD));
          const frameIdx = Math.max(0, Math.min(canvases.length - 1, Math.round(frameRatio * (canvases.length - 1))));
          const cacheCanvas = canvases[frameIdx];

          let sampled = false;
          if (cacheCanvas) {
            if (!(cacheCanvas as any).imgData) {
              (cacheCanvas as any).imgData = cacheCanvas.getContext('2d')?.getImageData(0, 0, cacheCanvas.width, cacheCanvas.height);
            }
            const cacheImgData = (cacheCanvas as any).imgData;
            if (cacheImgData) {
              // 3D空間のX・Y座標から直接キャッシュ画像サイズにマッピング (比率ベースで誤差ゼロ)
              const pixelXRatio = Math.max(0, Math.min(1, (clampedSx + halfW) / volW));
              const pixelYRatio = Math.max(0, Math.min(1, (-clampedSy + halfH) / volH));
              const cx = Math.max(0, Math.min(cacheCanvas.width - 1, Math.round(pixelXRatio * cacheCanvas.width)));
              const cy = Math.max(0, Math.min(cacheCanvas.height - 1, Math.round(pixelYRatio * cacheCanvas.height)));
              const srcIdx = (cy * cacheCanvas.width + cx) * 4;

              data[destIdx] = cacheImgData.data[srcIdx];
              data[destIdx + 1] = cacheImgData.data[srcIdx + 1];
              data[destIdx + 2] = cacheImgData.data[srcIdx + 2];
              data[destIdx + 3] = 255;
              sampled = true;
            }
          }
          if (!sampled) {
            data[destIdx] = 0;
            data[destIdx + 1] = 0;
            data[destIdx + 2] = 0;
            data[destIdx + 3] = 0;
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);

      if (curtainTextureRef.current) {
        curtainTextureRef.current.needsUpdate = true;
      }
      return;
    }

    let texW = N;
    let texH = 128;
    if (extrudeDirection === 'Z') {
      texH = canvases.length;
    } else if (extrudeDirection === 'X') {
      texH = canvases[0]?.width || 960;
    } else {
      texH = canvases[0]?.height || 540;
    }

    if (canvas.width !== texW || canvas.height !== texH) {
      canvas.width = texW;
      canvas.height = texH;
    }

    const imgData = ctx.createImageData(texW, texH);
    const data = imgData.data;

    // ★通常モードでも安全なクランプオフセットを計算
    let safeOffset = currentOffsetVal;
    if (sweepAxis === 'X') {
      const minVal = linePointsMinMaxRef.current.min;
      const maxVal = linePointsMinMaxRef.current.max;
      safeOffset = Math.max(-volW / 2 - minVal, Math.min(volW / 2 - maxVal, currentOffsetVal));
    } else if (sweepAxis === 'Y') {
      const minVal = linePointsMinMaxRef.current.min;
      const maxVal = linePointsMinMaxRef.current.max;
      safeOffset = Math.max(-volH / 2 - minVal, Math.min(volH / 2 - maxVal, currentOffsetVal));
    } else if (sweepAxis === 'Z') {
      const minVal = linePointsMinMaxRef.current.min;
      const maxVal = linePointsMinMaxRef.current.max;
      safeOffset = Math.max(-volD / 2 - minVal, Math.min(volD / 2 - maxVal, currentOffsetVal));
    }

    // 座標に安全にクランプされた offset 値を加算してスライド軌跡を算出する
    const pathCoords = lastLinePointsRef.current.map(pt => {
      const opt = pt.clone();
      if (sweepAxis === 'X') opt.x += safeOffset;
      else if (sweepAxis === 'Y') opt.y += safeOffset;
      else if (sweepAxis === 'Z') opt.z += safeOffset;
      return getPixelCoordsLocal(opt);
    });



    for (let v = 0; v < texH; v++) {
      for (let u = 0; u < N; u++) {
        const coords = pathCoords[u];
        let frameIdx = 0;
        let sampleX = 0;
        let sampleY = 0;

        if (extrudeDirection === 'Z') {
          // Z軸押し出し (前面・背面クリック、縦軸 v は時間)
          frameIdx = Math.round((v / (texH - 1)) * (canvases.length - 1));
          sampleX = Math.round(coords.x * samplingScale);
          sampleY = Math.round(coords.y * samplingScale);
        } 
        else if (extrudeDirection === 'X') {
          // X軸押し出し (左右側面、縦軸 v は X座標)
          const frameRatio = coords.frame / totalFrames;
          frameIdx = Math.round(frameRatio * (canvases.length - 1));
          
          const cacheCanvas = canvases[frameIdx];
          sampleX = Math.round((v / (texH - 1)) * cacheCanvas.width);
          sampleY = Math.round(coords.y * samplingScale);
        } 
        else {
          // Y軸押し出し (天底面、縦軸 v は Y座標)
          const frameRatio = coords.frame / totalFrames;
          frameIdx = Math.round(frameRatio * (canvases.length - 1));
          
          const cacheCanvas = canvases[frameIdx];
          sampleX = Math.round(coords.x * samplingScale);
          sampleY = Math.round((v / (texH - 1)) * cacheCanvas.height);
        }

        const cacheCanvas = canvases[frameIdx];
        
        // ★遅延初期化: キャッシュ画像から ImageData を取得していない場合はその場で取得して保持する (ロード漏れ防止)
        if (cacheCanvas && !(cacheCanvas as any).imgData) {
          (cacheCanvas as any).imgData = cacheCanvas.getContext('2d')?.getImageData(0, 0, cacheCanvas.width, cacheCanvas.height);
        }

        const cx = Math.max(0, Math.min(cacheCanvas.width - 1, sampleX));
        const cy = Math.max(0, Math.min(cacheCanvas.height - 1, sampleY));

        const cacheImgData = (cacheCanvas as any).imgData;
        if (cacheImgData) {
          const srcIdx = (cy * cacheCanvas.width + cx) * 4;
          const destIdx = (v * texW + u) * 4;

          data[destIdx] = cacheImgData.data[srcIdx];
          data[destIdx + 1] = cacheImgData.data[srcIdx + 1];
          data[destIdx + 2] = cacheImgData.data[srcIdx + 2];
          data[destIdx + 3] = 255;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // 3D上のテクスチャをバインドしている場合は WebGL に更新を通知する (同一Canvasを参照しているため、コピー不要で needsUpdate するだけ)
    if (curtainTextureRef.current) {
      curtainTextureRef.current.needsUpdate = true;
    }
  };

  // 24fps アニメーションループタイマー (ピンポン境界制御 - バックグラウンドでの動作を保証するため setInterval を使用)
  useEffect(() => {
    if (!isPlaying2D || isScanning) return;

    const interval = 1000 / 24; // 24fps

    const timerId = setInterval(() => {
      // スライドのステップ幅を定義 (ボリューム幅の 1/120 程度にする)
      let step = 0.01;
      let minBound = -volW / 2;
      let maxBound = volW / 2;

      if (sweepAxis === 'VIEW') {
        const maxOffset = Math.max(volW, volH, volD) * 0.4;
        minBound = -maxOffset;
        maxBound = maxOffset;
        step = (maxOffset * 2 / 75) * 0.5 * playSpeed;
      } else if (sweepAxis === 'X') {
        step = (volW / 75) * 0.5 * playSpeed;
        minBound = -volW / 2;
        maxBound = volW / 2;
      } else if (sweepAxis === 'Y') {
        step = (volH / 75) * 0.5 * playSpeed;
        minBound = -volH / 2;
        maxBound = volH / 2;
      } else {
        step = (volD / 75) * 0.5 * playSpeed;
        minBound = -volD / 2;
        maxBound = volD / 2;
      }

      let dir = offsetDirectionRef.current;
      
      setOffsetVal(prevOffset => {
        let nextOffset = prevOffset + step * dir;

        if (sweepAxis === 'VIEW') {
          // VIEWモード: -maxBound 〜 +maxBound でスムーズにピンポン往復
          if (dir > 0 && nextOffset >= maxBound) {
            dir = -1;
            offsetDirectionRef.current = -1;
            nextOffset = maxBound;
          } else if (dir < 0 && nextOffset <= minBound) {
            dir = 1;
            offsetDirectionRef.current = 1;
            nextOffset = minBound;
          }
        } else {
          const minVal = linePointsMinMaxRef.current.min;
          const maxVal = linePointsMinMaxRef.current.max;
          const pathWidth = maxVal - minVal;
          const volWidth = maxBound - minBound;
          const margin = volWidth - pathWidth;

          if (margin > 0.05) {
            // A. 可動域（マージン）が十分にある場合：
            // メッシュがボリュームの端に接触した瞬間に即座に切り返す（タイムラグなしでピンポン）
            const offsetLimitMax = maxBound - maxVal;
            const offsetLimitMin = minBound - minVal;

            if (dir > 0 && nextOffset >= offsetLimitMax) {
              dir = -1;
              offsetDirectionRef.current = -1;
              nextOffset = offsetLimitMax;
            } else if (dir < 0 && nextOffset <= offsetLimitMin) {
              dir = 1;
              offsetDirectionRef.current = 1;
              nextOffset = offsetLimitMin;
            }
          } else {
            // B. 可動域がほぼゼロ（幅いっぱいに描かれている）の場合：
            // ボリューム外に突き抜けてテクスチャが破綻しないよう、オフセットを0に保持
            nextOffset = 0;
          }
        }

        // サンプリングCanvas of 2D & Texture の更新
        drawPreviewCanvas(nextOffset);
        return nextOffset;
      });
    }, interval);

    return () => {
      clearInterval(timerId);
    };
  }, [isPlaying2D, scanFrames, isScanning, volW, volH, volD, sweepAxis, playSpeed]);

  // 静止中または手動更新用 (再生オフのときもスイープ軸やオフセット変更に追従)
  useEffect(() => {
    if (!isPlaying2D) {
      drawPreviewCanvas(offsetVal);
    }
  }, [offsetVal, isPlaying2D, sweepAxis]);

  // 動画データのサイズ更新時にボリューム寸法を再計算する
  const updateVolumeSize = (w: number, h: number, frames: number) => {
    const maxDim = Math.max(w, h, frames);
    const scale = 2.5 / maxDim;

    setVolW(w * scale);
    setVolH(h * scale);
    setVolD(frames * scale);
  };

  // テクスチャの初期化・再生成
  const initVolumeTextures = (w: number, h: number, sf: number) => {
    // 既存テクスチャの破棄
    setTextures(prev => {
      if (prev.front) prev.front.dispose();
      if (prev.back) prev.back.dispose();
      if (prev.left) prev.left.dispose();
      if (prev.right) prev.right.dispose();
      if (prev.top) prev.top.dispose();
      if (prev.bottom) prev.bottom.dispose();
      return { front: null, back: null, left: null, right: null, top: null, bottom: null };
    });

    const c = canvasesRef.current;
    if (!c.front || !c.back || !c.left || !c.right || !c.top || !c.bottom) return;

    // キャンバスのリサイズ
    c.front.width = w;
    c.front.height = h;
    c.back.width = w;
    c.back.height = h;

    c.left.width = sf;
    c.left.height = h;
    c.right.width = sf;
    c.right.height = h;

    c.top.width = w;
    c.top.height = sf;
    c.bottom.width = w;
    c.bottom.height = sf;

    // 黒塗りで初期化
    const ctx = ctxRef.current;
    if (ctx.front) {
      ctx.front.fillStyle = '#000000';
      ctx.front.fillRect(0, 0, w, h);
    }
    if (ctx.back) {
      ctx.back.fillStyle = '#000000';
      ctx.back.fillRect(0, 0, w, h);
    }
    if (ctx.left) {
      ctx.left.fillStyle = '#000000';
      ctx.left.fillRect(0, 0, sf, h);
    }
    if (ctx.right) {
      ctx.right.fillStyle = '#000000';
      ctx.right.fillRect(0, 0, sf, h);
    }
    if (ctx.top) {
      ctx.top.fillStyle = '#000000';
      ctx.top.fillRect(0, 0, w, sf);
    }
    if (ctx.bottom) {
      ctx.bottom.fillStyle = '#000000';
      ctx.bottom.fillRect(0, 0, w, sf);
    }

    // 新しいテクスチャの生成
    const texFront = new THREE.CanvasTexture(c.front);
    const texBack = new THREE.CanvasTexture(c.back);
    const texLeft = new THREE.CanvasTexture(c.left);
    const texRight = new THREE.CanvasTexture(c.right);
    const texTop = new THREE.CanvasTexture(c.top);
    const texBottom = new THREE.CanvasTexture(c.bottom);

    [texFront, texBack, texLeft, texRight, texTop, texBottom].forEach(tex => {
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
    });

    // UVマッピング調整 (3D空間の時間軸: 手前+Z＝開始, 奥-Z＝終了)
    texLeft.wrapS = THREE.RepeatWrapping;
    texLeft.repeat.x = -1;
    texLeft.offset.x = 1;

    texTop.wrapT = THREE.RepeatWrapping;
    texTop.repeat.y = -1;
    texTop.offset.y = 1;

    texBottom.wrapT = THREE.RepeatWrapping;
    texBottom.repeat.y = -1;
    texBottom.offset.y = 1;

    const newTextures = {
      front: texFront,
      back: texBack,
      left: texLeft,
      right: texRight,
      top: texTop,
      bottom: texBottom
    };

    texturesRef.current = newTextures;
    setTextures(newTextures);
  };

  // ビデオメタデータ読み込み時のハンドリング
  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;

    const w = video.videoWidth;
    const h = video.videoHeight;
    let tf = 300;
    if (video.duration) {
      tf = Math.round(video.duration * 30);
    }
    
    // x, y, z 共通の縮小率を算出 (最大次元が 960 以下になるようにスケールする)
    const maxDim = Math.max(w, h, tf);
    const maxTarget = 960;
    const scale = maxDim > maxTarget ? maxTarget / maxDim : 1.0;
    setSamplingScale(scale);

    const sf = Math.min(tf, 75); // 最大75フレーム

    setVideoWidth(w);
    setVideoHeight(h);
    setTotalFrames(tf);
    setScanFrames(sf);

    // テクスチャと物理比率をリサイズ
    initVolumeTextures(w, h, sf);
    updateVolumeSize(w, h, tf);

    const scanTf = Math.round(tf * scale);

    // 【対策1】Safari readyState >= 2 (HAVE_CURRENT_DATA) 待機
    if (video.readyState < 2) {
      const onCanPlay = () => {
        video.removeEventListener('canplay', onCanPlay);
        startVideoScan(video, scanTf);
      };
      video.addEventListener('canplay', onCanPlay);
    } else {
      startVideoScan(video, scanTf);
    }
  };

  // スキャン開始処理 (scanTf ＝ 縮小された総フレーム数)
  const startVideoScan = async (video: HTMLVideoElement, scanTf: number) => {
    setIsScanning(true);
    isScanningRef.current = true;
    currentScanFrameRef.current = 0;
    setScanProgressText("scan start: 0%");
    setScanProgressPercent(0);
    setScanCompleted(false);

    // キャッシュクリア
    scanFrameCanvasesRef.current.forEach(c => {
      (c as any).imgData = null;
    });
    scanFrameCanvasesRef.current = [];

    // 【対策3】Safari 用のビデオデコーダー活性化 (一瞬 play() してから pause())
    try {
      await video.play();
    } catch (_e) {
      // 自動再生制限のフォールバック
    }
    video.pause();

    seekAndScan(video, scanTf);
  };

  // シーク実行関数
  const seekAndScan = (video: HTMLVideoElement, scanTf: number) => {
    if (!isScanningRef.current) return;
    const currentFrame = currentScanFrameRef.current;

    if (currentFrame < scanTf) {
      const targetTime = (currentFrame / (scanTf - 1)) * video.duration;
      const nextTime = Math.max(0, Math.min(video.duration - 0.01, targetTime));

      // 【対策2】currentTime = 0 で seeked が発火しない仕様を考慮し、手動で handleSeeked を呼ぶ
      if (Math.abs(video.currentTime - nextTime) < 0.0001) {
        handleSeeked();
      } else {
        video.currentTime = nextTime;
      }
    } else {
      endVideoScan();
    }
  };

  // シーク完了ハンドラ
  const handleSeeked = () => {
    const video = videoRef.current;
    if (!video || !isScanningRef.current) return;

    // 【対策1】ピクセルデータがロード完了するまで待機 (readyState >= 2)
    if (video.readyState < 2) {
      setTimeout(() => handleSeeked(), 30);
      return;
    }

    const currentFrame = currentScanFrameRef.current;
    const sf = scanFrames; // 3Dボリューム側面の解像度用 (75)
    const scanTf = Math.round(totalFrames * samplingScale); // 共通スケールでの総スキャン数

    const percent = Math.round((currentFrame / scanTf) * 100);
    setScanProgressText(`scanning: ${percent}%`);
    setScanProgressPercent(percent);

    // タイムスライス用にビデオフレームを共通スケールで縮小してキャッシュ (x, y の縮小率を z と同じにする)
    const cacheCanvas = document.createElement('canvas');
    cacheCanvas.width = Math.round(videoWidth * samplingScale);
    cacheCanvas.height = Math.round(videoHeight * samplingScale);
    const cacheCtx = cacheCanvas.getContext('2d');
    if (cacheCtx) {
      cacheCtx.drawImage(video, 0, 0, cacheCanvas.width, cacheCanvas.height);
    }
    scanFrameCanvasesRef.current.push(cacheCanvas);

    // 各側面の 2D キャンバスへピクセルコピー (3Dボリューム構築)
    const ctx = ctxRef.current;
    const texs = texturesRef.current;
    const w = videoWidth;
    const h = videoHeight;

    // 前面 (最初のフレーム)
    if (currentFrame === 0 && ctx.front) {
      ctx.front.drawImage(video, 0, 0, w, h);
      
      // iPad Safari 等で blob: URL 動画の非表示 video が黒い場合、モーダルのアクティブ動画からフォールバック抽出
      const modalVid = modalVideoRef.current;
      if (modalVid && modalVid.readyState >= 2) {
        ctx.front.drawImage(modalVid, 0, 0, w, h);
      }

      if (texs.front) texs.front.needsUpdate = true;
    }

    // 背面 (最終フレームを左右反転したもの)
    if (currentFrame === scanTf - 1 && ctx.back) {
      ctx.back.save();
      ctx.back.translate(w, 0);
      ctx.back.scale(-1, 1);
      ctx.back.drawImage(video, 0, 0, w, h);
      ctx.back.restore();
      if (texs.back) texs.back.needsUpdate = true;
    }

    // ボリューム側面のインデックス位置を算出 (全フレームからボリューム用の 75列へ射影)
    const volCol = Math.round((currentFrame / (scanTf - 1)) * (sf - 1));

    // スリットスキャン (ボリューム側面の 75列の該当ピクセルへ描き込み)
    if (ctx.left) {
      ctx.left.drawImage(video, 0, 0, 1, h, volCol, 0, 1, h);
      if (texs.left) texs.left.needsUpdate = true;
    }
    if (ctx.right) {
      ctx.right.drawImage(video, w - 1, 0, 1, h, volCol, 0, 1, h);
      if (texs.right) texs.right.needsUpdate = true;
    }
    if (ctx.top) {
      ctx.top.drawImage(video, 0, 0, w, 1, 0, volCol, w, 1);
      if (texs.top) texs.top.needsUpdate = true;
    }
    if (ctx.bottom) {
      ctx.bottom.drawImage(video, 0, h - 1, w, 1, 0, volCol, w, 1);
      if (texs.bottom) texs.bottom.needsUpdate = true;
    }

    currentScanFrameRef.current++;
    seekAndScan(video, scanTf);
  };

  // スキャン完了
  const endVideoScan = () => {
    setIsScanning(false);
    isScanningRef.current = false;

    // 【対策3】前面 (1フレーム目) の確実な抽出・再適用フォールバック (モーダル動画からの抽出含む)
    const ctx = ctxRef.current;
    const texs = texturesRef.current;
    if (ctx.front && texs.front) {
      if (scanFrameCanvasesRef.current.length > 0) {
        const firstCanvas = scanFrameCanvasesRef.current[0];
        ctx.front.drawImage(firstCanvas, 0, 0, videoWidth, videoHeight);
      }
      const modalVid = modalVideoRef.current;
      if (modalVid && modalVid.readyState >= 2) {
        ctx.front.drawImage(modalVid, 0, 0, videoWidth, videoHeight);
      }
      texs.front.needsUpdate = true;
    }

    // テクスチャのアップロード更新
    Object.values(texturesRef.current).forEach(tex => {
      if (tex) tex.needsUpdate = true;
    });

    setScanCompleted(true);
    
    // プレビューの初期黒描画
    drawPreviewCanvas(0);
  };

  // 動画ファイルの選択・ロード
  const handleImportClick = () => {
    if (videoInputRef.current) {
      videoInputRef.current.click();
    }
  };

  const handleVideoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // 以前の断面をすべて破棄
      clearAllCurtains();

      // 以前の Blob URL メモリをブラウザから解約・解放する (メモリリーク防止)
      if (videoSrc && videoSrc.startsWith('blob:')) {
        URL.revokeObjectURL(videoSrc);
      }

      const fileURL = URL.createObjectURL(file);
      setVideoSrc(fileURL);
      setIsModalOpen(true);
      setScanCompleted(false);

      // input の選択値をクリア (同ファイル・連続選択の再発火を保証)
      e.target.value = '';
    }
  };

  // 以前の断面（カーテン）のクリーンアップ
  const clearAllCurtains = () => {
    curtains.forEach(curtain => {
      curtain.geometry.dispose();
      if (Array.isArray(curtain.material)) {
        curtain.material.forEach(m => m.dispose());
      } else {
        curtain.material.dispose();
      }
    });
    setCurtains([]);
    setVolumeOpacity(1.0); // 不透明に戻す
    lastLinePointsRef.current = [];
    setSweepAxis('X'); // デフォルトを X に変更
    setOffsetVal(0); // 物理オフセット値をリセット
    offsetDirectionRef.current = 1; // ピンポン方向をリセット
    
    // 既存テクスチャも明示的に WebGL メモリから解放・破棄する (解像度変更対策)
    if (curtainTextureRef.current) {
      curtainTextureRef.current.dispose();
      curtainTextureRef.current = null;
    }
    
    drawPreviewCanvas(0); // プレビューをクリア
  };

  // 軌跡の選択軸における最小値と最大値を計算するヘルパー関数
  const calcMinMax = (points: THREE.Vector3[], axis: 'X' | 'Y' | 'Z' | 'VIEW') => {
    if (axis === 'VIEW') {
      return { min: viewDepthRangeRef.current.min, max: viewDepthRangeRef.current.max };
    }
    if (points.length === 0) return { min: 0, max: 0 };
    let minVal = axis === 'X' ? points[0].x : axis === 'Y' ? points[0].y : points[0].z;
    let maxVal = minVal;
    for (let i = 1; i < points.length; i++) {
      const val = axis === 'X' ? points[i].x : axis === 'Y' ? points[i].y : points[i].z;
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
    return { min: minVal, max: maxVal };
  };

  // --- ドローイング中座標の逆変換・表示処理 ---
  const handlePointSampled = (_point: THREE.Vector3, _status: 'START' | 'DRAW') => {
    // 座標表示機能廃止のため空処理
  };

  // ドローイング開始時の完全初期化リセットハンドラ (マウスダウン)
  const handleDrawStart = () => {
    setIsPlaying2D(false); // 再生を強制停止
    clearAllCurtains(); // 以前のカーテン、オフセット、走査軸等をリセット
  };

  // 押し出し方向に応じて利用可能なスイープ軸のリストを定義する
  const getAvailableSweepAxes = (dir: 'X' | 'Y' | 'Z' | 'VIEW') => {
    if (dir === 'VIEW') {
      return [
        { value: 'VIEW', label: '視線方向 (奥行きにスライド)' },
        { value: 'Z', label: 'Z軸方向 (時間軸にスライド)' }
      ];
    } else if (dir === 'Z') {
      return [
        { value: 'X', label: 'X軸方向 (左右にスライド)' },
        { value: 'Y', label: 'Y軸方向 (上下にスライド)' }
      ];
    } else if (dir === 'X') {
      return [
        { value: 'Y', label: 'Y軸方向 (上下にスライド)' },
        { value: 'Z', label: 'Z軸方向 (時間軸にスライド)' }
      ];
    } else {
      return [
        { value: 'X', label: 'X軸方向 (左右にスライド)' },
        { value: 'Z', label: 'Z軸方向 (時間軸にスライド)' }
      ];
    }
  };

  const getSweepAxisIcon = (axis: 'X' | 'Y' | 'Z' | 'VIEW') => {
    if (axis === 'VIEW') return <LuEye size={30} />;
    if (axis === 'X') return <LuArrowLeftRight size={30} />;
    if (axis === 'Y') return <LuArrowUpDown size={30} />;
    return <LuClock size={30} />;
  };

  // 軌跡の点を一切制限せずそのまま返す
  const limitPoints = (points: THREE.Vector3[]): THREE.Vector3[] => {
    return points;
  };

  // ★新規: ドラッグ中のリアルタイムスリットスキャン更新関数
  const handleDrawProgress = (linePoints: THREE.Vector3[], extrudeDirection: 'X' | 'Y' | 'Z') => {
    // 軌跡を最大600点に制限（アスペクト比潰れ防止）
    const limited = limitPoints(linePoints);
    lastLinePointsRef.current = limited;

    // 押し出し方向が変わった場合、スイープ軸を自動的に有効な初期値に更新する
    let currentAxis = sweepAxis;
    if (lastExtrudeDirectionRef.current !== extrudeDirection) {
      const axes = getAvailableSweepAxes(extrudeDirection);
      currentAxis = axes[0].value as 'X' | 'Y' | 'Z';
      setSweepAxis(currentAxis);
    }
    lastExtrudeDirectionRef.current = extrudeDirection;

    // 限界値（境界）の計算
    linePointsMinMaxRef.current = calcMinMax(limited, currentAxis);

    // キャッシュ画像から ImageData を事前取得していない場合は初期化
    const canvases = scanFrameCanvasesRef.current;
    canvases.forEach(canvas => {
      if (!(canvas as any).imgData) {
        (canvas as any).imgData = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height);
      }
    });

    // プレビューの2Dスリットスキャン画像をドラッグの動きに連動して即時更新描画する (初期オフセット 0)
    drawPreviewCanvas(0);
  };

  // ドローイング完了時のタイムスライス（3D断面曲面）生成
  const handleDrawComplete = (linePoints: THREE.Vector3[], extrudeDirection: 'X' | 'Y' | 'Z') => {
    // 軌跡を最大600点に制限（アスペクト比潰れ防止）
    const limited = limitPoints(linePoints);
    
    // ★重要: ドラッグ完了時の最終リサンプリング軌跡を lastLinePointsRef に確実に同期保存する (UI軸変更時の再計算バグ防止)
    lastLinePointsRef.current = limited;

    const N = limited.length;
    const canvases = scanFrameCanvasesRef.current;
    if (N < 2 || canvases.length === 0) return;

    // 押し出し方向が変わった場合、スイープ軸を自動的に有効な初期値に更新する
    let currentAxis = sweepAxis;
    if (lastExtrudeDirectionRef.current !== extrudeDirection) {
      const axes = getAvailableSweepAxes(extrudeDirection);
      currentAxis = axes[0].value as 'X' | 'Y' | 'Z';
      setSweepAxis(currentAxis);
    }
    lastExtrudeDirectionRef.current = extrudeDirection;

    // 限界値（境界）の計算
    linePointsMinMaxRef.current = calcMinMax(limited, currentAxis);

    // ★重要: CanvasTexture を新規生成（アロケーション）する前に、
    // まず drawPreviewCanvas(0) を呼んで、previewCanvas のサイズ（アスペクト比）と描画を
    // 今回の extrudeDirection に沿った解像度 (YT面なら 960, TX面なら 540) に同期・更新させておく！
    drawPreviewCanvas(0);

    // 1. 3D ジオメトリ (THREE.BufferGeometry) の作成
    const geom = new THREE.BufferGeometry();
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < N; i++) {
      const pt = limited[i];
      if (extrudeDirection === 'Z') {
        positions.push(pt.x, pt.y, volD / 2);  // 手前
        positions.push(pt.x, pt.y, -volD / 2); // 奥
      } 
      else if (extrudeDirection === 'X') {
        positions.push(-volW / 2, pt.y, pt.z); // 左
        positions.push(volW / 2, pt.y, pt.z);  // 右
      } 
      else {
        positions.push(pt.x, volH / 2, pt.z);  // 上
        positions.push(pt.x, -volH / 2, pt.z); // 下
      }

      const uRatio = i / (N - 1);
      uvs.push(uRatio, 1); // Canvasの上端(v=0)に同期
      uvs.push(uRatio, 0); // Canvasの下端(v=texH)に同期
    }

    for (let i = 0; i < N - 1; i++) {
      const i00 = i * 2;
      const i01 = i * 2 + 1;
      const i10 = (i + 1) * 2;
      const i11 = (i + 1) * 2 + 1;

      indices.push(i00, i01, i10);
      indices.push(i01, i11, i10);
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    // 2. マテリアル用のテクスチャ生成 (previewCanvas をそのままテクスチャソースとする)
    const previewCanvas = previewCanvasRef.current;
    if (!previewCanvas) return;

    // 3Dカーテン用マテリアルテクスチャの生成。アスペクト比の変更をWebGLに正しく通知するため、常に既存オブジェクトを廃棄し新規生成する
    if (curtainTextureRef.current) {
      curtainTextureRef.current.dispose();
    }

    curtainTextureRef.current = new THREE.CanvasTexture(previewCanvas);
    curtainTextureRef.current.colorSpace = THREE.SRGBColorSpace;
    curtainTextureRef.current.minFilter = THREE.LinearFilter;
    curtainTextureRef.current.magFilter = THREE.LinearFilter;
    curtainTextureRef.current.needsUpdate = true;

    const curtainTexture = curtainTextureRef.current;

    const curtainMat = new THREE.MeshBasicMaterial({
      map: curtainTexture,
      side: THREE.DoubleSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });

    // 3Dシーンに追加
    setCurtains([{ geometry: geom, material: curtainMat }]);
    setVolumeOpacity(0.3); // 断面が見えるようにボリュームを30%の半透明にする

    // コンソールに一連の座標を出力
    const sampledCoords = limited.map(pt => getPixelCoordsLocal(pt));
    console.log("=== DRAWING PATH COORDINATES (X, Y, Frame) ===");
    console.table(sampledCoords);
  };

  // AABB (直方体ボリューム境界) と半直線の交差深度区間 [tmin, tmax] を計算するヘルパー
  const computeAABBIntersection = (
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    boxMin: THREE.Vector3,
    boxMax: THREE.Vector3
  ): { tmin: number; tmax: number } | null => {
    let tmin = -Infinity;
    let tmax = Infinity;

    const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
    for (const axis of axes) {
      const o = origin[axis];
      const d = dir[axis];
      const min = boxMin[axis];
      const max = boxMax[axis];

      if (Math.abs(d) < 1e-8) {
        if (o < min || o > max) return null;
      } else {
        let t1 = (min - o) / d;
        let t2 = (max - o) / d;
        if (t1 > t2) {
          const temp = t1;
          t1 = t2;
          t2 = temp;
        }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return null;
      }
    }
    return { tmin, tmax };
  };

  // ★新規: グリースペンシル完了時 (視線直交断面曲面) 生成ハンドラ
  const handleGreasePencilComplete = (
    linePoints: THREE.Vector3[], 
    viewDir: THREE.Vector3, 
    cameraPos?: THREE.Vector3
  ) => {
    const limited = limitPoints(linePoints);
    lastLinePointsRef.current = limited;

    const N = limited.length;
    const canvases = scanFrameCanvasesRef.current;
    if (N < 2 || canvases.length === 0) return;

    // 押し出しモードと視線方向ベクトル・カメラ位置を同期
    lastExtrudeDirectionRef.current = 'VIEW';
    const normalizedViewDir = viewDir.clone().normalize();
    viewDirectionRef.current = normalizedViewDir;
    if (cameraPos) {
      cameraPositionRef.current = cameraPos.clone();
    }

    // スイープ軸を 'VIEW' (視線方向) にセット
    setSweepAxis('VIEW');

    // ボリュームの AABB 直方体境界
    const boxMin = new THREE.Vector3(-volW / 2, -volH / 2, -volD / 2);
    const boxMax = new THREE.Vector3(volW / 2, volH / 2, volD / 2);
    const camPos = cameraPos || cameraPositionRef.current;

    // 各ストローク点ごとに、カメラからの視線レイ方向と AABB 交差深度 [tmin, tmax] を正確に個別計算
    const ranges: Array<{ tmin: number; tmax: number; dir: THREE.Vector3 }> = [];
    let globalTmin = Infinity;
    let globalTmax = -Infinity;

    // デフォルトのフォールバック交差範囲
    const centerHit = computeAABBIntersection(new THREE.Vector3(0, 0, 0), normalizedViewDir, boxMin, boxMax);
    const defaultTmin = centerHit ? centerHit.tmin : -volD / 2;
    const defaultTmax = centerHit ? centerHit.tmax : volD / 2;

    for (let i = 0; i < N; i++) {
      const pt = limited[i];
      // 透視投影カメラの各点へのレイ方向ベクトル (視差によるZ軸ズレを防止)
      const rayDir = camPos ? pt.clone().sub(camPos).normalize() : normalizedViewDir.clone();
      const hit = computeAABBIntersection(pt, rayDir, boxMin, boxMax);
      if (hit) {
        ranges.push({ tmin: hit.tmin, tmax: hit.tmax, dir: rayDir });
        globalTmin = Math.min(globalTmin, hit.tmin);
        globalTmax = Math.max(globalTmax, hit.tmax);
      } else {
        // ヒットしない場合は中心視線方向の交差でフォールバック
        const fallbackHit = computeAABBIntersection(pt, normalizedViewDir, boxMin, boxMax);
        if (fallbackHit) {
          ranges.push({ tmin: fallbackHit.tmin, tmax: fallbackHit.tmax, dir: normalizedViewDir.clone() });
          globalTmin = Math.min(globalTmin, fallbackHit.tmin);
          globalTmax = Math.max(globalTmax, fallbackHit.tmax);
        } else {
          ranges.push({ tmin: defaultTmin, tmax: defaultTmax, dir: normalizedViewDir.clone() });
          globalTmin = Math.min(globalTmin, defaultTmin);
          globalTmax = Math.max(globalTmax, defaultTmax);
        }
      }
    }

    pointRangesRef.current = ranges;
    viewDepthRangeRef.current = { min: globalTmin, max: globalTmax };
    linePointsMinMaxRef.current = { min: globalTmin, max: globalTmax };

    // プレビュー用 Canvas にスリットスキャン画像を即座に描画生成
    drawPreviewCanvas(0);

    // 3D カーテンジオメトリ (BufferGeometry) の作成: 各点ごとの正確な境界で押し出し
    const geom = new THREE.BufferGeometry();
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < N; i++) {
      const pt = limited[i];
      const { tmin, tmax, dir } = ranges[i];
      // ボリュームの手前表面から奥表面まで正確に吸着した頂点座標
      const pFront = pt.clone().addScaledVector(dir, tmin); // 手前端
      const pBack = pt.clone().addScaledVector(dir, tmax);  // 奥端

      positions.push(pFront.x, pFront.y, pFront.z);
      positions.push(pBack.x, pBack.y, pBack.z);

      const uRatio = i / (N - 1);
      uvs.push(uRatio, 1); // 手前 (Canvas上端 y=0)
      uvs.push(uRatio, 0); // 奥 (Canvas下端 y=texH-1)
    }

    for (let i = 0; i < N - 1; i++) {
      const i00 = i * 2;
      const i01 = i * 2 + 1;
      const i10 = (i + 1) * 2;
      const i11 = (i + 1) * 2 + 1;

      indices.push(i00, i01, i10);
      indices.push(i01, i11, i10);
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const previewCanvas = previewCanvasRef.current;
    if (!previewCanvas) return;

    if (curtainTextureRef.current) {
      curtainTextureRef.current.dispose();
    }

    curtainTextureRef.current = new THREE.CanvasTexture(previewCanvas);
    curtainTextureRef.current.colorSpace = THREE.SRGBColorSpace;
    curtainTextureRef.current.minFilter = THREE.LinearFilter;
    curtainTextureRef.current.magFilter = THREE.LinearFilter;
    curtainTextureRef.current.needsUpdate = true;

    const curtainMat = new THREE.MeshBasicMaterial({
      map: curtainTextureRef.current,
      side: THREE.DoubleSide,
      depthWrite: true,
      transparent: true,
      alphaTest: 0.005,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });

    setCurtains([{ geometry: geom, material: curtainMat }]);
    setVolumeOpacity(0.3);
  };

  // 子ウィンドウから状態を取得したり、操作を行えるようにグローバルに露出させる
  if (typeof window !== 'undefined') {
    (window as any).timesectorState = {
      isPlaying2D,
      setIsPlaying2D,
      sweepAxis,
      setSweepAxis,
      playSpeed,
      setPlaySpeed,
      setOffsetVal,
      lastLinePoints: lastLinePointsRef.current,
      lastExtrudeDirection: lastExtrudeDirectionRef.current,
      limitPoints: limitPoints,
      calcMinMax: calcMinMax,
      linePointsMinMaxRef: linePointsMinMaxRef,
      offsetDirectionRef: offsetDirectionRef,
      drawPreviewCanvas: drawPreviewCanvas
    };
  }

  // --- 子ウィンドウ専用プレビューレンダリング ---
  if (viewMode === 'preview') {
    return (
      <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden', backgroundColor: '#ffffff', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <canvas id="preview-canvas" ref={previewCanvasRef} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </div>
    );
  }

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 上部横長配置 of 巨大ロゴ */}
      <div id="info-panel">
        <h1>timesector-ext</h1>
      </div>

      <div className={`viewer-workspace ${isPopoutOpen ? 'popout-active' : ''}`}>
        {/* [左半分] R3F 3D ビューアコンポーネント */}
        <ThreeVolume
          toolMode={toolMode}
          volW={volW}
          volH={volH}
          volD={volD}
          volumeOpacity={volumeOpacity}
          textures={textures}
          curtains={curtains}
          playOffset={offsetVal}
          scanFrames={scanFrames}
          sweepAxis={sweepAxis}
          viewDirection={viewDirectionRef.current}
          onDrawStart={handleDrawStart}
          onDrawProgress={handleDrawProgress}
          onDrawComplete={handleDrawComplete}
          onGreasePencilComplete={handleGreasePencilComplete}
          onPointSampled={handlePointSampled}
          isPopoutOpen={isPopoutOpen}
        />

        {/* 左右のビューを分ける極細デバイダー線 */}
        <div className="view-divider" />

        {/* volumeビューのフローティングヘッダーセクション */}
        <div className="view-header" style={isPopoutOpen ? { width: 'calc(100vw - 80px)', left: '40px' } : { width: 'calc(50vw - 80px)', left: '40px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <div className="view-title">volume</div>
            {isScanning && (
              <span style={{ fontSize: '11px', color: 'rgba(0, 0, 0, 0.4)', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', letterSpacing: '0.05em' }}>
                {scanProgressText}
              </span>
            )}
          </div>
          <div className="view-controls">
            <input 
              type="file" 
              ref={videoInputRef}
              onChange={handleVideoFileChange}
              accept="video/*" 
              style={{ display: 'none' }} 
            />
            <button 
              onClick={handleImportClick} 
              disabled={isScanning}
              data-tooltip="Open File / Import"
            >
              <LuFolderOpen size={30} />
            </button>
            <button 
              className={toolMode === 'rotate' ? 'active' : ''} 
              onClick={() => setToolMode('rotate')}
              data-tooltip="Pan / Select (V)"
            >
              <LuRotate3D size={30} />
            </button>
            <button 
              className={toolMode === 'draw' ? 'active' : ''} 
              onClick={() => setToolMode('draw')}
              data-tooltip="Slice / Draw / Edit (D)"
            >
              <MdDraw size={30} />
            </button>
            <button 
              className={toolMode === 'greasePencil' ? 'active' : ''} 
              onClick={() => setToolMode('greasePencil')}
              data-tooltip="Grease Pencil / View Slice (G)"
            >
              <LuPencil size={30} />
            </button>

            {/* 以下、全てvolumeビュー側へ移動してきた2D操作系統ボタン */}
            <button 
              className={isPlaying2D ? 'active' : ''} 
              onClick={() => setIsPlaying2D(!isPlaying2D)}
              disabled={lastLinePointsRef.current.length === 0}
              data-tooltip={isPlaying2D ? 'Pause' : 'Play'}
            >
              {isPlaying2D ? <FaPause size={26} /> : <FaPlay size={26} />}
            </button>
            {lastLinePointsRef.current.length >= 2 && 
              getAvailableSweepAxes(lastExtrudeDirectionRef.current).map(opt => (
                <button
                  key={opt.value}
                  className={sweepAxis === opt.value ? 'active' : ''}
                  data-tooltip={opt.label}
                  onClick={() => {
                    const newAxis = opt.value as 'X' | 'Y' | 'Z' | 'VIEW';
                    setSweepAxis(newAxis);
                    setOffsetVal(0);
                    offsetDirectionRef.current = 1;

                    // 新しいスイープ軸に合わせて軌跡全体の最小・最大限界座標を再計算する (当たり判定バグ防止)
                    if (lastLinePointsRef.current.length > 0) {
                      const limited = limitPoints(lastLinePointsRef.current);
                      linePointsMinMaxRef.current = calcMinMax(limited, newAxis);
                    }

                    // 即時に新しいスイープ軸基準で2Dプレビュー画像を描画更新する
                    drawPreviewCanvas(0);
                  }}
                >
                  {getSweepAxisIcon(opt.value as 'X' | 'Y' | 'Z' | 'VIEW')}
                </button>
              ))
            }

            {/* 再生速度調整（視覚的スライダー＆倍率切替ボタン） */}
            {lastLinePointsRef.current.length >= 2 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '4px' }}>
                <button
                  style={{ fontSize: '13px', fontWeight: 700, width: 'auto', padding: '0 6px', height: '44px' }}
                  onClick={() => {
                    const speeds = [0.25, 0.5, 1, 1.5, 2, 3];
                    const idx = speeds.indexOf(playSpeed);
                    const next = speeds[idx >= 0 ? (idx + 1) % speeds.length : 2];
                    setPlaySpeed(next);
                  }}
                  data-tooltip={`Speed: ${playSpeed}x (Click to cycle)`}
                >
                  {playSpeed}x
                </button>
                <input
                  type="range"
                  min="0.25"
                  max="3.0"
                  step="0.25"
                  value={playSpeed}
                  onChange={(e) => setPlaySpeed(parseFloat(e.target.value))}
                  style={{ width: '60px', cursor: 'pointer', accentColor: '#000' }}
                  data-tooltip={`Speed: ${playSpeed}x`}
                />
              </div>
            )}
          </div>
        </div>

        {/* 3Dボリューム底辺に沿う極細のシーケンス進捗バー */}
        {isScanning && (
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '50vw',
            height: '1.5px',
            backgroundColor: 'rgba(0, 0, 0, 0.05)',
            zIndex: 10
          }}>
            <div style={{
              width: `${scanProgressPercent}%`,
              height: '100%',
              backgroundColor: '#000000',
              transition: 'width 0.1s ease-out'
            }} />
          </div>
        )}

        {/* [右半分] 生成された 2D スリットスキャン動画ビューア */}
        <div id="preview-container">
          <div className="view-header">
            <div className="view-title">preview</div>
            <div className="view-controls">
              <button 
                onClick={popoutPreview}
                data-tooltip="Open in New Window"
              >
                <LuExternalLink size={30} />
              </button>
            </div>
          </div>
          <canvas id="preview-canvas" ref={previewCanvasCallbackRef} />
        </div>
      </div>

      {/* 【対策3】HTML5 Video 要素 (display:none による描画バッファ破棄を防ぐため画面外配置にする) */}
      <video
        ref={videoRef}
        crossOrigin="anonymous"
        src={videoSrc}
        loop={false}
        muted={true}
        autoPlay={false}
        playsInline={true}
        style={{
          position: 'fixed',
          left: '-9999px',
          top: '-9999px',
          width: '1px',
          height: '1px',
          opacity: 0,
          pointerEvents: 'none'
        }}
        onLoadedMetadata={handleLoadedMetadata}
        onSeeked={handleSeeked}
      />

      {/* モーダルウィンドウ */}
      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>input video preview</h2>
            
            <div className="modal-video-wrapper">
              <video
                ref={modalVideoRef}
                src={videoSrc}
                autoPlay
                loop
                muted
                playsInline
                className="modal-preview-video"
                onLoadedData={() => {
                  const ctx = ctxRef.current;
                  const texs = texturesRef.current;
                  const modalVid = modalVideoRef.current;
                  if (ctx?.front && texs?.front && modalVid && modalVid.readyState >= 2) {
                    ctx.front.drawImage(modalVid, 0, 0, videoWidth, videoHeight);
                    texs.front.needsUpdate = true;
                  }
                }}
              />
            </div>

            <div className="scan-progress-wrapper" style={{ width: '100%' }}>
              <div className="scan-progress-text">{scanProgressText}</div>
              <div className="scan-progress-container">
                <div className="scan-progress-bar" style={{ width: `${scanProgressPercent}%` }}></div>
              </div>
            </div>

            {scanCompleted && (
              <button 
                className="btn-slit-scan-go"
                onClick={() => setIsModalOpen(false)}
              >
                start
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
