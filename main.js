import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseGIF, decompressFrames } from 'gifuct-js';

/**
 * 全局变量声明
 */
let scene, camera, renderer, composer;
let particleSystem = null;
window.particleSystem = null;
let particleGeometry = null;
let particleMaterial = null;
let scatterSystem = null;
window.scatterSystem = null;
let scatterGeometry = null;
let scatterMaterial = null;
let scatterOriginalPositions = null;  // 飘散粒子聚合位置
let scatterRandomPositions = null;    // 飘散粒子分散位置
let controls = null;
let bloomPass = null;
let ambientLight = null;
let pointLight1 = null;
let pointLight2 = null;

let originalPositions = [];
let randomPositions = [];
let randomZOffsets = [];
let particleColors = [];
let particleSizes = [];

let targetScrollProgress = 0.3;
let currentScrollProgress = 0.3;
let clock = new THREE.Clock();

// ===== GIF 动画相关变量 =====
let gifFrames = [];              // GIF 各帧的 ImageData 数组
let gifFrameColors = [];         // 每帧对应的粒子颜色数据（Float32Array[]）
let gifFrameIndex = 0;           // 当前播放帧索引
let gifLastFrameTime = 0;        // 上一帧切换时间戳
let gifFrameDelay = 100;         // 帧间隔（毫秒），默认 100ms
let isGifPlaying = false;        // 是否正在播放 GIF
let gifCanvas = null;            // 用于合成 GIF 帧的离屏 Canvas
let gifCtx = null;               // 离屏 Canvas 上下文
let scatterFrameColors = [];     // 飘散粒子每帧对应的颜色数据（Float32Array[]）
let scatterValidPixels = null;   // 飘散粒子的采样像素映射（复用于帧颜色提取）

const SAMPLE_WIDTH = 400;
const SAMPLE_HEIGHT = 400;
const PARTICLE_SIZE_BASE = 0.085;
const SPREAD_FACTOR = 20;
const MAX_Z_DEPTH = 16;

/**
 * 初始化Three.js场景
 * 创建渲染环境、相机、光照和后期处理效果
 */
function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    
    // 增强雾化效果：前后粒子更明显分离
    scene.fog = new THREE.FogExp2(0x000000, 0.028);

    // 相机设置：稍远 + 略微俯视角度增强立体感
    camera = new THREE.PerspectiveCamera(
        65,  // 稍微减小FOV增加透视感
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );
    camera.position.set(0, 1, 22);  // Y轴偏移1单位产生轻微俯视

    renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance"
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    // 前方主光源（暖色）
    ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    // 前上方主光
    pointLight1 = new THREE.PointLight(0xffaa66, 2.2, 60);
    pointLight1.position.set(12, 10, 15);
    scene.add(pointLight1);

    // 后下方补光（冷色）- 增强前后对比和立体感
    pointLight2 = new THREE.PointLight(0x4466ff, 1.5, 50);
    pointLight2.position.set(-8, -6, -10);
    scene.add(pointLight2);

    composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        1.8,
        0.4,
        0.2
    );
    composer.addPass(bloomPass);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enableZoom = false;
    controls.autoRotate = false;

    window.addEventListener('resize', onWindowResize);
}

/**
 * 处理窗口尺寸变化
 * 更新相机宽高比和渲染器/合成器尺寸
 */
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    if (controls) {
        controls.update();
    }
}

/**
 * 处理图片上传并解析像素数据
 * 支持 JPG/PNG 静态图片和 GIF 动图
 * @param {Event} event - 文件选择事件对象
 */
function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const isGif = file.type === 'image/gif';

    if (!isGif && !file.type.match(/image\/(jpeg|png)/)) {
        alert('请上传 JPG、PNG 或 GIF 格式的图片');
        return;
    }

    if (isGif) {
        handleGifUpload(file);
    } else {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                processImage(img);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }
}

/**
 * 处理 GIF 文件上传
 * 解析 GIF 帧数据，提取每帧像素颜色，用第一帧初始化粒子系统，后续帧驱动颜色动画
 * @param {File} file - GIF 文件对象
 */
async function handleGifUpload(file) {
    try {
        updateStatus('✦ LOADING GIF... ✦', 'default');

        const arrayBuffer = await file.arrayBuffer();
        const gif = parseGIF(arrayBuffer);
        const frames = decompressFrames(gif, true);

        if (!frames || frames.length === 0) {
            alert('无法解析此 GIF 文件');
            return;
        }

        // 停止之前的 GIF 播放
        isGifPlaying = false;
        gifFrames = [];
        gifFrameColors = [];
        gifFrameIndex = 0;
        scatterFrameColors = [];
        scatterValidPixels = null;

        // 计算采样尺寸（与静态图保持一致的宽高比逻辑）
        const gifWidth = gif.lsd.width;
        const gifHeight = gif.lsd.height;
        const aspectRatio = gifWidth / gifHeight;
        const clampedWidth = Math.min(Math.round(SAMPLE_HEIGHT * aspectRatio), 520);

        // 创建离屏 Canvas 用于合成 GIF 帧
        gifCanvas = document.createElement('canvas');
        gifCanvas.width = clampedWidth;
        gifCanvas.height = SAMPLE_HEIGHT;
        gifCtx = gifCanvas.getContext('2d', { willReadFrequently: true });

        // 临时 Canvas 用于绘制单帧 patch
        const patchCanvas = document.createElement('canvas');
        patchCanvas.width = gifWidth;
        patchCanvas.height = gifHeight;
        const patchCtx = patchCanvas.getContext('2d');

        // 预提取每帧的完整像素数据
        // GIF 帧可能是局部 patch（只更新部分区域），需要逐帧合成完整画面
        const fullCanvas = document.createElement('canvas');
        fullCanvas.width = gifWidth;
        fullCanvas.height = gifHeight;
        const fullCtx = fullCanvas.getContext('2d');

        // 记录采样映射：哪些像素位置对应哪些粒子
        // 先用第一帧建立映射，后续帧复用同一映射
        let samplingMap = null;

        for (let f = 0; f < frames.length; f++) {
            const frame = frames[f];
            const patchImageData = frame.patch;
            const dims = frame.dims;

            // 将当前帧 patch 绘制到 patchCanvas
            const imgData = new ImageData(
                new Uint8ClampedArray(patchImageData),
                dims.width,
                dims.height
            );
            patchCtx.clearRect(0, 0, gifWidth, gifHeight);

            // 处理 GIF 帧的 disposal 方式
            if (frame.disposalType === 2) {
                // 恢复为背景色（清除上一帧区域）
                fullCtx.clearRect(dims.left, dims.top, dims.width, dims.height);
            } else if (frame.disposalType === 3) {
                // 恢复为前一帧（暂不处理，简单方案直接覆盖）
            }

            // 将 patch 绘制到完整画布上
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = dims.width;
            tempCanvas.height = dims.height;
            tempCanvas.getContext('2d').putImageData(imgData, 0, 0);
            fullCtx.drawImage(tempCanvas, dims.left, dims.top);

            // 从完整画布采样到目标尺寸
            gifCtx.clearRect(0, 0, clampedWidth, SAMPLE_HEIGHT);
            gifCtx.drawImage(fullCanvas, 0, 0, clampedWidth, SAMPLE_HEIGHT);

            const sampledImageData = gifCtx.getImageData(0, 0, clampedWidth, SAMPLE_HEIGHT);
            gifFrames.push(sampledImageData);

            // 提取该帧的粒子颜色数据
            const result = extractColorsFromImageData(
                sampledImageData,
                clampedWidth,
                SAMPLE_HEIGHT,
                f === 0 ? null : samplingMap  // 第一帧建立映射，后续帧复用
            );

            if (f === 0) {
                // 第一帧：建立粒子系统，保存采样映射
                samplingMap = result.samplingMap;
                gifFrameColors.push(result.colors);
            } else {
                // 后续帧：只保存颜色数据，复用映射
                gifFrameColors.push(result.colors);
            }

            // 同时提取飘散粒子该帧的颜色数据
            const scatterResult = extractScatterColorsFromImageData(
                sampledImageData,
                clampedWidth,
                SAMPLE_HEIGHT,
                f === 0 ? null : scatterValidPixels
            );
            if (f === 0) {
                scatterValidPixels = scatterResult.pixelMap;
            }
            scatterFrameColors.push(scatterResult.colors);
        }

        // 使用第一帧数据初始化粒子系统
        initializeParticlesFromGif(gifFrames[0], clampedWidth, SAMPLE_HEIGHT, samplingMap);

        // 设置帧延迟（取第一帧的 delay，单位 1/100 秒）
        gifFrameDelay = frames[0].delay || 10;
        if (gifFrameDelay < 2) gifFrameDelay = 10;  // 极短延迟保护

        // 启动 GIF 播放
        isGifPlaying = true;
        gifLastFrameTime = performance.now();
        gifFrameIndex = 0;

        updateStatus('✦ GIF LOADED ✦', 'success');

        // 播放入场动画
        targetScrollProgress = 0;
        currentScrollProgress = 0;

        setTimeout(() => {
            closeDrawer();
        }, 800);

        const animationDuration = 4000;
        const animationStart = performance.now();

        function playGatherAnimation(currentTime) {
            const elapsed = currentTime - animationStart;
            const progress = Math.min(elapsed / animationDuration, 1);
            const easedProgress = 1 - (1 - progress) * (1 - progress);
            targetScrollProgress = easedProgress * 1.0;
            if (progress < 1) {
                requestAnimationFrame(playGatherAnimation);
            }
        }

        requestAnimationFrame(playGatherAnimation);

    } catch (err) {
        console.error('GIF 解析失败:', err);
        alert('GIF 解析失败，请尝试其他文件');
        updateStatus('✦ GIF LOAD FAILED ✦', 'default');
    }
}

/**
 * 从 ImageData 提取粒子颜色数据
 * 支持两种模式：首次调用建立采样映射，后续调用复用映射
 * @param {ImageData} imageData - 帧的像素数据
 * @param {number} width - 采样宽度
 * @param {number} height - 采样高度
 * @param {Array|null} existingMap - 已有的采样映射（null 时新建映射）
 * @returns {{ colors: Float32Array, samplingMap: Array }} 颜色数组和采样映射
 */
function extractColorsFromImageData(imageData, width, height, existingMap) {
    const data = imageData.data;
    const scaleX = 0.065;
    const scaleY = 0.065;
    const colors = [];
    const samplingMap = existingMap || [];

    // 如果没有已有映射，需要新建（第一帧）
    if (!existingMap) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                const r = data[i] / 255;
                const g = data[i + 1] / 255;
                const b = data[i + 2] / 255;
                const a = data[i + 3] / 255;

                if (a < 0.1) continue;

                const brightness = (r + g + b) / 3;
                if (brightness < 0.01) continue;

                const probability = Math.min(1, brightness * 0.92 + 0.35);
                if (Math.random() > probability) continue;

                // 记录该粒子的像素坐标和随机种子
                samplingMap.push({ x, y, seed: Math.random() });
                colors.push(r, g, b);
            }
        }
    } else {
        // 复用已有映射，按相同顺序提取颜色
        for (let m = 0; m < existingMap.length; m++) {
            const { x, y, seed } = existingMap[m];
            const i = (y * width + x) * 4;

            let r = data[i] / 255;
            let g = data[i + 1] / 255;
            let b = data[i + 2] / 255;
            const a = data[i + 3] / 255;

            // 透明像素保留上一帧颜色（通过使用 0,0,0，后续在播放时跳过）
            if (a < 0.1) {
                r = 0; g = 0; b = 0;
            }

            colors.push(r, g, b);
        }
    }

    return {
        colors: new Float32Array(colors),
        samplingMap
    };
}

/**
 * 使用 GIF 第一帧数据初始化粒子系统
 * 与 processImage 逻辑一致，但使用预提取的采样映射确保帧间粒子对应关系一致
 * @param {ImageData} firstFrame - 第一帧的像素数据
 * @param {number} clampedWidth - 采样宽度
 * @param {number} clampedHeight - 采样高度
 * @param {Array} samplingMap - 采样映射（包含像素坐标和随机种子）
 */
function initializeParticlesFromGif(firstFrame, clampedWidth, clampedHeight, samplingMap) {
    const data = firstFrame.data;
    const scaleX = 0.065;
    const scaleY = 0.065;

    originalPositions = [];
    randomPositions = [];
    randomZOffsets = [];
    particleColors = [];
    particleSizes = [];

    for (let m = 0; m < samplingMap.length; m++) {
        const { x, y, seed } = samplingMap[m];
        const i = (y * clampedWidth + x) * 4;
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const a = data[i + 3] / 255;

        if (a < 0.1) continue;

        const brightness = (r + g + b) / 3;
        if (brightness < 0.01) continue;

        const baseX = (x - clampedWidth / 2) * scaleX;
        const baseY = -(y - clampedHeight / 2) * scaleY;

        const jitterStrength = 0.03 + seed * 0.04;
        const jitterX = (seed - 0.5) * jitterStrength;
        const jitterY = ((seed * 1.7) % 1 - 0.5) * jitterStrength;

        const posX = baseX + jitterX;
        const posY = baseY + jitterY;

        originalPositions.push(posX, posY, 0);

        // 放射状分散位置
        const distFromCenter = Math.sqrt(posX * posX + posY * posY);
        const angleFromCenter = Math.atan2(posY, posX);

        const baseBlastRadius = SPREAD_FACTOR * (0.6 + seed * 1.2);
        const distanceScale = 1.5 + (distFromCenter / 8.0) * 2.0;
        const blastRadius = baseBlastRadius * distanceScale;

        const angleSpread = ((seed * 3.1) % 1 - 0.5) * (Math.PI / 3.6);
        const blastAngle = angleFromCenter + angleSpread;

        const randomX = Math.cos(blastAngle) * blastRadius;
        const randomY = Math.sin(blastAngle) * blastRadius;

        const zDirection = Math.sign(posX * Math.cos(angleFromCenter) + posY * Math.sin(angleFromCenter));
        const randomZ = zDirection * (seed * MAX_Z_DEPTH * 1.5) + ((seed * 2.3) % 1 - 0.5) * MAX_Z_DEPTH;

        randomPositions.push(randomX, randomY, randomZ);
        randomZOffsets.push(randomZ);

        particleColors.push(r, g, b);

        const brightnessFactor = 0.5 + brightness * 0.9;
        const randomScale = 0.6 + seed * 0.8;
        const size = PARTICLE_SIZE_BASE * brightnessFactor * randomScale;
        particleSizes.push(size);
    }

    createParticleSystem();
    createScatterSystem(data, clampedWidth, clampedHeight);
}

/**
 * 从 ImageData 提取飘散粒子颜色数据（用于 GIF 帧动画）
 * 采样逻辑与 createScatterSystem 完全一致：隔3像素采样 + Z轴深度柱
 * @param {ImageData} imageData - 帧的像素数据
 * @param {number} width - 采样宽度
 * @param {number} height - 采样高度
 * @param {Array|null} existingPixelMap - 已有的像素映射（null 时新建映射）
 * @returns {{ colors: Float32Array, pixelMap: Array }} 颜色数组和像素映射
 */
function extractScatterColorsFromImageData(imageData, width, height, existingPixelMap) {
    const data = imageData.data;
    const SAMPLE_STEP = 3;
    const colors = [];
    const pixelMap = existingPixelMap || [];

    if (!existingPixelMap) {
        // 第一帧：建立像素映射
        for (let y = 0; y < height; y += SAMPLE_STEP) {
            for (let x = 0; x < width; x += SAMPLE_STEP) {
                const pi = (y * width + x) * 4;
                const r = data[pi] / 255;
                const g = data[pi + 1] / 255;
                const b = data[pi + 2] / 255;
                const a = data[pi + 3] / 255;
                const brightness = (r + g + b) / 3;

                if (a < 0.1 || brightness < 0.05) continue;

                const forwardLayers = brightness > 0.4
                    ? Math.floor(1 + brightness * 2)
                    : Math.floor(1 + brightness * 1);
                const backwardLayers = brightness < 0.6
                    ? Math.floor(1 + (1 - brightness) * 2)
                    : Math.floor(1 + (1 - brightness) * 1);

                pixelMap.push({ x, y, forwardLayers, backwardLayers });

                // 前方深度柱颜色
                for (let layer = 1; layer <= forwardLayers; layer++) {
                    const fadeFactor = 1.0 - (layer / (forwardLayers + 1)) * 0.3;
                    colors.push(
                        Math.min(1, r * fadeFactor * 1.1),
                        Math.min(1, g * fadeFactor * 1.1),
                        Math.min(1, b * fadeFactor * 1.1)
                    );
                }

                // 后方深度柱颜色
                for (let layer = 1; layer <= backwardLayers; layer++) {
                    const fadeFactor = 1.0 - (layer / (backwardLayers + 1)) * 0.4;
                    colors.push(
                        Math.min(1, r * fadeFactor * 0.9),
                        Math.min(1, g * fadeFactor * 0.92),
                        Math.min(1, b * fadeFactor * 1.05)
                    );
                }
            }
        }
    } else {
        // 后续帧：复用像素映射，只提取颜色
        for (let m = 0; m < existingPixelMap.length; m++) {
            const { x, y, forwardLayers, backwardLayers } = existingPixelMap[m];
            const pi = (y * width + x) * 4;
            const r = data[pi] / 255;
            const g = data[pi + 1] / 255;
            const b = data[pi + 2] / 255;
            const a = data[pi + 3] / 255;

            const cr = a < 0.1 ? 0 : r;
            const cg = a < 0.1 ? 0 : g;
            const cb = a < 0.1 ? 0 : b;

            // 前方深度柱颜色
            for (let layer = 1; layer <= forwardLayers; layer++) {
                const fadeFactor = 1.0 - (layer / (forwardLayers + 1)) * 0.3;
                colors.push(
                    Math.min(1, cr * fadeFactor * 1.1),
                    Math.min(1, cg * fadeFactor * 1.1),
                    Math.min(1, cb * fadeFactor * 1.1)
                );
            }

            // 后方深度柱颜色
            for (let layer = 1; layer <= backwardLayers; layer++) {
                const fadeFactor = 1.0 - (layer / (backwardLayers + 1)) * 0.4;
                colors.push(
                    Math.min(1, cr * fadeFactor * 0.9),
                    Math.min(1, cg * fadeFactor * 0.92),
                    Math.min(1, cb * fadeFactor * 1.05)
                );
            }
        }
    }

    return {
        colors: new Float32Array(colors),
        pixelMap
    };
}

/**
 * 更新 GIF 帧动画
 * 在主动画循环中调用，按帧间隔切换粒子颜色
 * @param {number} currentTime - 当前时间戳（performance.now()）
 */
function updateGifFrame(currentTime) {
    if (!isGifPlaying || gifFrameColors.length <= 1) return;
    if (!particleGeometry) return;

    const elapsed = currentTime - gifLastFrameTime;
    if (elapsed < gifFrameDelay) return;

    // 切换到下一帧
    gifFrameIndex = (gifFrameIndex + 1) % gifFrameColors.length;
    gifLastFrameTime = currentTime;

    const frameColors = gifFrameColors[gifFrameIndex];
    if (!frameColors || frameColors.length === 0) return;

    // 诊断：记录主粒子与飘散粒子的颜色数组长度对比（仅首次帧切换时输出一次）
    if (!updateGifFrame._hasLogged && gifFrameIndex === 1) {
        updateGifFrame._hasLogged = true;
        const scatterAttr = scatterGeometry ? scatterGeometry.attributes.vColor3 : null;
        const mainGeoArray = particleGeometry.attributes.vColor3.array;
        console.log('[GIF帧切换诊断] frameIndex:', gifFrameIndex,
            '主粒子几何体颜色长度:', mainGeoArray.length,
            '主粒子帧颜色长度:', frameColors.length,
            '是否完全匹配:', mainGeoArray.length === frameColors.length ? '✓' : '✗ 不匹配!',
            '飘散粒子颜色长度:', scatterAttr ? scatterAttr.array.length : 'N/A',
            'scatterFrameColors长度:', scatterFrameColors.length,
            '本次scatterFrameColor长度:', scatterFrameColors[gifFrameIndex] ? scatterFrameColors[gifFrameIndex].length : 'N/A');
        // 检查场景中是否有重复的 Points 对象
        const pointsInScene = scene.children.filter(c => c.isPoints);
        console.log('[场景诊断] 场景中 Points 对象数量:', pointsInScene.length,
            'particleSystem === scene中第1个?:', pointsInScene[0] === particleSystem,
            'scatterSystem === scene中最后1个?:', pointsInScene[pointsInScene.length - 1] === scatterSystem);
        if (pointsInScene.length > 2) {
            console.warn('[场景诊断] ⚠ 发现多余的 Points 对象! 总数:', pointsInScene.length);
        }
    }

    // 更新粒子颜色 buffer
    const colorAttr = particleGeometry.attributes.vColor3;
    if (!colorAttr) return;

    const colorArray = colorAttr.array;
    const len = Math.min(colorArray.length, frameColors.length);

    for (let i = 0; i < len; i++) {
        colorArray[i] = frameColors[i];
    }

    colorAttr.needsUpdate = true;

    // 同步更新全局 particleColors（供波纹等效果使用）
    for (let i = 0; i < len; i++) {
        particleColors[i] = frameColors[i];
    }

    // 同步更新飘散粒子颜色
    if (scatterGeometry && scatterFrameColors.length > 0) {
        const scatterColorAttr = scatterGeometry.attributes.vColor3;
        if (scatterColorAttr) {
            const scatterFrameColor = scatterFrameColors[gifFrameIndex];
            if (scatterFrameColor && scatterFrameColor.length > 0) {
                const scatterColorArray = scatterColorAttr.array;
                const scatterLen = Math.min(scatterColorArray.length, scatterFrameColor.length);
                for (let i = 0; i < scatterLen; i++) {
                    scatterColorArray[i] = scatterFrameColor[i];
                }
                scatterColorAttr.needsUpdate = true;
            } else {
                console.warn('[scatter] scatterFrameColor 为空或长度为零, frameIndex:', gifFrameIndex, 'scatterFrameColors.length:', scatterFrameColors.length);
            }
        } else {
            console.warn('[scatter] scatterGeometry.attributes.vColor3 不存在');
        }
    } else if (!scatterGeometry) {
        console.warn('[scatter] scatterGeometry 为 null，跳过颜色更新');
    }
}

/**
 * 处理图片并提取像素数据
 * 将图片绘制到Canvas上并读取像素颜色信息
 * 保持图片原始宽高比，固定高度，宽度按比例自适应
 * @param {HTMLImageElement} img - 已加载的图片元素
 */
function processImage(img) {
    // 上传静态图时停止 GIF 播放
    isGifPlaying = false;
    gifFrames = [];
    gifFrameColors = [];
    gifFrameIndex = 0;
    scatterFrameColors = [];
    scatterValidPixels = null;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // 计算保持宽高比的尺寸：固定高度，宽度自适应
    const aspectRatio = img.width / img.height;
    const actualWidth = Math.round(SAMPLE_HEIGHT * aspectRatio);
    
    // 限制最大宽度避免粒子过多（性能保护）
    const clampedWidth = Math.min(actualWidth, 520);

    canvas.width = clampedWidth;
    canvas.height = SAMPLE_HEIGHT;

    ctx.drawImage(img, 0, 0, clampedWidth, SAMPLE_HEIGHT);

    const imageData = ctx.getImageData(0, 0, clampedWidth, SAMPLE_HEIGHT);
    const data = imageData.data;

    originalPositions = [];
    randomPositions = [];
    randomZOffsets = [];
    particleColors = [];
    particleSizes = [];

    // 计算缩放因子使图像居中且大小合适
    const scaleX = 0.065;  // X轴单位像素对应的3D空间距离
    const scaleY = 0.065;   // Y轴单位像素对应的3D空间距离

    for (let y = 0; y < SAMPLE_HEIGHT; y++) {
        for (let x = 0; x < clampedWidth; x++) {
            const i = (y * clampedWidth + x) * 4;
            const r = data[i] / 255;
            const g = data[i + 1] / 255;
            const b = data[i + 2] / 255;
            const a = data[i + 3] / 255;

            if (a < 0.1) continue;

            const brightness = (r + g + b) / 3;
            if (brightness < 0.01) continue;

            // ===== 概率采样：亮度越高，生成粒子的概率越大 =====
            // 公式优化：brightness * 0.92 + 0.35 确保亮处高密度，暗处也有基础粒子
            const probability = Math.min(1, brightness * 0.92 + 0.35);
            if (Math.random() > probability) continue;

            // ===== 基于实际宽高比的位置计算（居中）=====
            const baseX = (x - clampedWidth / 2) * scaleX;
            const baseY = -(y - SAMPLE_HEIGHT / 2) * scaleY;

            // ===== 位置抖动：打破网格感（适度扰动） =====
            const jitterStrength = 0.03 + Math.random() * 0.04;  // 0.03-0.07的随机偏移
            const jitterX = (Math.random() - 0.5) * jitterStrength;
            const jitterY = (Math.random() - 0.5) * jitterStrength;

            const posX = baseX + jitterX;
            const posY = baseY + jitterY;

            originalPositions.push(posX, posY, 0);

            // ===== 放射状分散位置（沿中心向外方向爆炸）=====
            const distFromCenter = Math.sqrt(posX * posX + posY * posY);
            const angleFromCenter = Math.atan2(posY, posX);

            // 爆炸距离：基础距离 + 基于原距离的放大 + 随机扰动
            const baseBlastRadius = SPREAD_FACTOR * (0.6 + Math.random() * 1.2);
            const distanceScale = 1.5 + (distFromCenter / 8.0) * 2.0;  // 离中心越远飞得越远
            const blastRadius = baseBlastRadius * distanceScale;

            // 沿原方向向外 + 随机角度偏移（±25度）
            const angleSpread = (Math.random() - 0.5) * (Math.PI / 3.6);
            const blastAngle = angleFromCenter + angleSpread;

            const randomX = Math.cos(blastAngle) * blastRadius;
            const randomY = Math.sin(blastAngle) * blastRadius;
            
            // Z轴：前方粒子向前飞，后方粒子向后飞，增强立体放射感
            const zDirection = Math.sign(posX * Math.cos(angleFromCenter) + posY * Math.sin(angleFromCenter));
            const randomZ = zDirection * (Math.random() * MAX_Z_DEPTH * 1.5) + (Math.random() - 0.5) * MAX_Z_DEPTH;

            randomPositions.push(randomX, randomY, randomZ);
            randomZOffsets.push(randomZ);

            particleColors.push(r, g, b);

            // ===== 粒子大小：更大的变化范围，增强层次感 =====
            const brightnessFactor = 0.5 + brightness * 0.9;  // 0.5-1.4的范围
            const randomScale = 0.6 + Math.random() * 0.8;     // 0.6-1.4的随机缩放
            const size = PARTICLE_SIZE_BASE * brightnessFactor * randomScale;
            particleSizes.push(size);
        }
    }

    createParticleSystem();
    createScatterSystem(data, clampedWidth, SAMPLE_HEIGHT);

    updateStatus('✦ IMAGE LOADED ✦', 'success');

    // ===== 播放分散→聚合的入场动画 =====
    // 初始状态：完全分散
    targetScrollProgress = 0;
    currentScrollProgress = 0;

    // 延迟关闭抽屉，让用户先看到动画开始
    setTimeout(() => {
        closeDrawer();
    }, 800);

    // 动画参数配置
    const animationDuration = 4000;       // 动画总时长 4秒
    const animationStart = performance.now();
    const targetGatherProgress = 1.0;   // 完全聚合到 100%

    /**
     * 入场动画循环函数
     * 使用 easeOut 缓动实现：开始快速聚拢，逐渐减速到位
     */
    function playGatherAnimation(currentTime) {
        const elapsed = currentTime - animationStart;
        const progress = Math.min(elapsed / animationDuration, 1);

        // easeOutQuad: 快→慢，起步快，收尾慢
        const easedProgress = 1 - (1 - progress) * (1 - progress);

        // 更新目标滚动进度（animate函数会平滑插值跟随）
        targetScrollProgress = easedProgress * targetGatherProgress;

        if (progress < 1) {
            requestAnimationFrame(playGatherAnimation);
        }
    }

    // 启动入场动画
    requestAnimationFrame(playGatherAnimation);
}

/**
 * 创建粒子系统
 * 使用BufferGeometry和自定义ShaderMaterial构建高性能粒子效果
 */
function createParticleSystem() {
    if (particleSystem !== null) {
        scene.remove(particleSystem);
        particleGeometry.dispose();
        particleMaterial.dispose();
    }

    const particleCount = originalPositions.length / 3;

    particleGeometry = new THREE.BufferGeometry();

    const positions = new Float32Array(originalPositions.length);
    const colors = new Float32Array(particleColors);
    const sizes = new Float32Array(particleSizes);

    for (let i = 0; i < originalPositions.length; i += 3) {
        const t = currentScrollProgress;
        positions[i] = originalPositions[i] * t + randomPositions[i] * (1 - t);
        positions[i + 1] = originalPositions[i + 1] * t + randomPositions[i + 1] * (1 - t);
        positions[i + 2] = originalPositions[i + 2] * t + randomPositions[i + 2] * (1 - t);
    }

    particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeometry.setAttribute('vColor3', new THREE.BufferAttribute(colors, 3));
    particleGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    particleMaterial = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 },
            uGlowDecay: { value: 5.0 },
            uColorGlowMult: { value: 1.8 },
            uCoreBrightness: { value: 0.8 },
            uFlowGlowAmp: { value: 0.06 },
            uFgGlowCoef: { value: 0.05 },
            uPulseAmp: { value: 0.015 },
            uDepthFactor: { value: 0.15 }
        },
        vertexShader: `
            attribute float size;
            attribute vec3 vColor3;
            varying vec3 vColor;
            varying float vDistance;
            varying float vDepth;
            uniform float time;
            uniform float uPulseAmp;
            uniform float uDepthFactor;

            void main() {
                vColor = vColor3;
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                vDistance = -mvPosition.z;
                vDepth = position.z;

                // 基础大小衰减
                float sizeAttenuation = 400.0 / vDistance;
                gl_PointSize = size * sizeAttenuation;

                // Z轴深度影响
                float depthFactor = 1.0 + position.z * uDepthFactor;
                gl_PointSize *= depthFactor;

                // 时间脉动
                float pulse = 1.0 + sin(time * 2.0 + position.x * 5.0 + position.y * 3.0) * uPulseAmp;
                gl_PointSize *= pulse;

                gl_PointSize = clamp(gl_PointSize, 0.8, 45.0);

                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            varying vec3 vColor;
            varying float vDistance;
            varying float vDepth;
            uniform float time;
            uniform float uGlowDecay;
            uniform float uColorGlowMult;
            uniform float uCoreBrightness;
            uniform float uFlowGlowAmp;
            uniform float uFgGlowCoef;

            void main() {
                vec2 center = gl_PointCoord - vec2(0.5);
                float dist = length(center);

                if (dist > 0.5) discard;

                float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
                float glow = exp(-dist * uGlowDecay);

                // 基础颜色 + 发光
                vec3 finalColor = vColor * (1.0 + glow * uColorGlowMult);
                finalColor += vec3(0.15, 0.18, 0.28) * glow * 0.5;

                // 核心高亮区域
                float coreBrightness = exp(-dist * 10.0) * uCoreBrightness;
                finalColor += vec3(coreBrightness);

                // Z轴深度色调偏移
                float depthTint = smoothstep(-6.0, 6.0, vDepth);
                finalColor = mix(
                    finalColor * vec3(0.82, 0.88, 1.08),
                    finalColor * vec3(1.1, 1.0, 0.9),
                    depthTint
                );

                // 深度亮度调节
                float depthBrightness = mix(0.9, 1.08, depthTint);
                finalColor *= depthBrightness;

                // 深度淡出
                float depthFade = smoothstep(50.0, 8.0, vDistance);
                float zFade = smoothstep(-8.0, 6.0, vDepth) * 0.06 + 0.94;
                alpha *= depthFade * zFade;

                // 流水动态辉光
                float flowGlow = sin(time * 1.5 + vDepth * 2.5) * uFlowGlowAmp + (1.0 - uFlowGlowAmp * 0.33);
                finalColor *= flowGlow;

                // 前方粒子额外辉光
                float foregroundGlow = max(0.0, vDepth * uFgGlowCoef);
                finalColor += vec3(1.0, 0.92, 0.75) * foregroundGlow * glow * 1.0;

                gl_FragColor = vec4(finalColor, alpha * 1.0);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });

    particleSystem = new THREE.Points(particleGeometry, particleMaterial);
    window.particleSystem = particleSystem;
    scene.add(particleSystem);
}

/**
 * 创建Z轴深度挤出粒子系统
 * 对图片每个采样像素，沿Z轴方向生成一串同色粒子（深度柱）
 * 亮色区域向前凸出更长，暗色区域向后延伸，形成3D浮雕立体效果
 * @param {Uint8ClampedArray} data - 图片像素数据
 * @param {number} width - 采样宽度
 * @param {number} height - 采样高度
 */
function createScatterSystem(data, width, height) {
    // 清理旧的飘散粒子系统
    if (scatterSystem !== null) {
        scene.remove(scatterSystem);
        scatterGeometry.dispose();
        scatterMaterial.dispose();
    }

    const scaleX = 0.065;
    const scaleY = 0.065;

    // 收集图片有效像素，隔3像素采样控制密度
    const SAMPLE_STEP = 3;
    const validPixels = [];
    for (let y = 0; y < height; y += SAMPLE_STEP) {
        for (let x = 0; x < width; x += SAMPLE_STEP) {
            const pi = (y * width + x) * 4;
            const r = data[pi] / 255;
            const g = data[pi + 1] / 255;
            const b = data[pi + 2] / 255;
            const a = data[pi + 3] / 255;
            const brightness = (r + g + b) / 3;

            if (a < 0.1 || brightness < 0.05) continue;
            validPixels.push({ x, y, r, g, b, brightness });
        }
    }

    // 每个像素沿Z轴生成一串粒子（深度柱）
    // 亮色：向前挤出长（2~6层），暗色：向后挤出（1~3层）
    const allPositions = [];
    const allColors = [];
    const allSizes = [];

    for (let p = 0; p < validPixels.length; p++) {
        const pixel = validPixels[p];

        // XY位置：与图片像素位置精确对应
        const posX = (pixel.x - width / 2) * scaleX;
        const posY = -(pixel.y - height / 2) * scaleY;

        // 基于亮度计算深度柱的长度和方向
        // 亮度 > 0.5：向前凸出（靠近摄像机）
        // 亮度 <= 0.5：向后凹陷（远离摄像机）
        const brightness = pixel.brightness;

        // 前方深度柱层数（亮色更多层）
        const forwardLayers = brightness > 0.4
            ? Math.floor(1 + brightness * 2)     // 1~3层
            : Math.floor(1 + brightness * 1);     // 1~2层

        // 后方深度柱层数（暗色更多层）
        const backwardLayers = brightness < 0.6
            ? Math.floor(1 + (1 - brightness) * 2)  // 1~3层
            : Math.floor(1 + (1 - brightness) * 1);  // 1~2层

        // 前方深度柱：从Z=0向摄像机方向逐层放置
        const forwardStep = 0.6 + brightness * 0.8;  // 每层间距：0.6~1.4
        for (let layer = 1; layer <= forwardLayers; layer++) {
            const zPos = layer * forwardStep * (0.7 + Math.random() * 0.6);
            // 越远离主平面的粒子XY抖动越大，形成"扩散"感
            const spread = layer * 0.04;
            allPositions.push(
                posX + (Math.random() - 0.5) * spread,
                posY + (Math.random() - 0.5) * spread,
                zPos
            );
            // 颜色：越远越淡（模拟雾化/空气透视）
            const fadeFactor = 1.0 - (layer / (forwardLayers + 1)) * 0.3;
            allColors.push(
                Math.min(1, pixel.r * fadeFactor * 1.1),
                Math.min(1, pixel.g * fadeFactor * 1.1),
                Math.min(1, pixel.b * fadeFactor * 1.1)
            );
            // 大小：越远越小（靠近摄像机的会被透视放大）
            const sizeFade = 1.0 - (layer / (forwardLayers + 1)) * 0.3;
            allSizes.push((0.06 + Math.random() * 0.04) * sizeFade);
        }

        // 后方深度柱：从Z=0向远离摄像机方向逐层放置
        const backwardStep = 0.5 + (1 - brightness) * 0.7;  // 每层间距：0.5~1.2
        for (let layer = 1; layer <= backwardLayers; layer++) {
            const zPos = -(layer * backwardStep * (0.7 + Math.random() * 0.6));
            const spread = layer * 0.03;
            allPositions.push(
                posX + (Math.random() - 0.5) * spread,
                posY + (Math.random() - 0.5) * spread,
                zPos
            );
            // 后方粒子颜色偏冷偏暗
            const fadeFactor = 1.0 - (layer / (backwardLayers + 1)) * 0.4;
            allColors.push(
                Math.min(1, pixel.r * fadeFactor * 0.9),
                Math.min(1, pixel.g * fadeFactor * 0.92),
                Math.min(1, pixel.b * fadeFactor * 1.05)  // 蓝通道略增，偏冷
            );
            allSizes.push((0.05 + Math.random() * 0.035) * fadeFactor);
        }
    }

    const totalCount = allPositions.length / 3;
    const finalPositions = new Float32Array(allPositions);
    const finalColors = new Float32Array(allColors);
    const finalSizes = new Float32Array(allSizes);

    // 存储聚合位置（深度柱位置）
    scatterOriginalPositions = new Float32Array(finalPositions);

    // 生成分散位置：沿中心放射状爆炸
    scatterRandomPositions = new Float32Array(finalPositions.length);
    for (let i = 0; i < totalCount; i++) {
        const ox = scatterOriginalPositions[i * 3];
        const oy = scatterOriginalPositions[i * 3 + 1];

        const distFromCenter = Math.sqrt(ox * ox + oy * oy);
        const angleFromCenter = Math.atan2(oy, ox);

        // 放射状爆炸距离
        const blastRadius = SPREAD_FACTOR * (0.5 + Math.random() * 1.0);
        const distanceScale = 1.2 + (distFromCenter / 8.0) * 1.5;
        const angleSpread = (Math.random() - 0.5) * (Math.PI / 3.6);
        const blastAngle = angleFromCenter + angleSpread;

        scatterRandomPositions[i * 3] = Math.cos(blastAngle) * blastRadius * distanceScale;
        scatterRandomPositions[i * 3 + 1] = Math.sin(blastAngle) * blastRadius * distanceScale;
        // Z轴也随机分散
        const zDirection = Math.sign(ox) || 1;
        scatterRandomPositions[i * 3 + 2] = zDirection * Math.random() * MAX_Z_DEPTH + (Math.random() - 0.5) * MAX_Z_DEPTH;
    }

    scatterGeometry = new THREE.BufferGeometry();
    scatterGeometry.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
    scatterGeometry.setAttribute('vColor3', new THREE.BufferAttribute(finalColors, 3));
    scatterGeometry.setAttribute('size', new THREE.BufferAttribute(finalSizes, 1));

    scatterMaterial = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 },
            uGlowDecay: { value: 4.0 },
            uColorGlowMult: { value: 2.0 },
            uCoreBrightness: { value: 0.6 },
            uPulseAmp: { value: 0.06 },
            uFlowGlowAmp: { value: 0.05 },
            uDepthFactor: { value: 0.12 }
        },
        vertexShader: `
            attribute float size;
            attribute vec3 vColor3;
            varying vec3 vColor;
            varying float vDistance;
            varying float vDepth;
            uniform float time;
            uniform float uPulseAmp;
            uniform float uDepthFactor;

            void main() {
                vColor = vColor3;
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                vDistance = -mvPosition.z;
                vDepth = position.z;

                float sizeAttenuation = 400.0 / vDistance;
                gl_PointSize = size * sizeAttenuation;

                // Z轴深度影响
                float depthFactor = 1.0 + position.z * uDepthFactor;
                gl_PointSize *= depthFactor;

                // 脉动动画
                float pulse = 1.0 + sin(time * 2.0 + position.x * 4.0 + position.z * 3.0) * uPulseAmp;
                gl_PointSize *= pulse;

                gl_PointSize = clamp(gl_PointSize, 0.5, 35.0);

                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            varying vec3 vColor;
            varying float vDistance;
            varying float vDepth;
            uniform float time;
            uniform float uGlowDecay;
            uniform float uColorGlowMult;
            uniform float uCoreBrightness;
            uniform float uFlowGlowAmp;

            void main() {
                vec2 center = gl_PointCoord - vec2(0.5);
                float dist = length(center);

                if (dist > 0.5) discard;

                float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
                float glow = exp(-dist * uGlowDecay);

                vec3 finalColor = vColor * (1.0 + glow * uColorGlowMult);
                finalColor += vec3(0.1, 0.12, 0.18) * glow * 0.3;

                float coreBrightness = exp(-dist * 10.0) * uCoreBrightness;
                finalColor += vec3(coreBrightness);

                // 深度色调偏移
                float depthTint = smoothstep(-5.0, 5.0, vDepth);
                finalColor = mix(
                    finalColor * vec3(0.8, 0.85, 1.1),
                    finalColor * vec3(1.15, 1.05, 0.85),
                    depthTint
                );

                // 深度淡出
                float depthFade = smoothstep(50.0, 6.0, vDistance);
                float zFade = smoothstep(-5.0, 5.0, vDepth) * 0.1 + 0.9;
                alpha *= depthFade * zFade;

                // 流水动态辉光
                float flowGlow = sin(time * 1.5 + vDepth * 2.5) * uFlowGlowAmp + (1.0 - uFlowGlowAmp * 0.33);
                finalColor *= flowGlow;

                gl_FragColor = vec4(finalColor, alpha * 0.85);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });

    scatterSystem = new THREE.Points(scatterGeometry, scatterMaterial);
    window.scatterSystem = scatterSystem;
    scene.add(scatterSystem);
}

/**
 * 更新粒子位置
 * 基于当前滚动进度在原始位置和随机分散位置之间进行插值
 * 添加整体协调的波纹起伏动画（像飘动的旗帜/水面涟漪）
 */
function updateParticlePositions() {
    if (!particleSystem || !particleGeometry) return;

    const positions = particleGeometry.attributes.position.array;
    const t = easeInOutCubic(currentScrollProgress);
    const time = clock.getElapsedTime();

    // ===== 波纹系统全局参数 =====
    
    // 波纹基础强度（随聚合度变化）
    const baseRippleStrength = 0.15 + t * 0.25;  // 聚合时波纹稍强

    // 诊断：采样前3个粒子的颜色RGB值，验证帧间变化（每60帧输出一次）
    if (!updateParticlePositions._frameCounter) updateParticlePositions._frameCounter = 0;
    updateParticlePositions._frameCounter++;
    if (updateParticlePositions._frameCounter % 60 === 0 && isGifPlaying) {
        const geoColor = particleGeometry.attributes.vColor3.array;
        console.log('[主粒子颜色采样] frameIndex:', gifFrameIndex,
            'particleColors[0-5]:', particleColors[0], particleColors[1], particleColors[2],
            '| geo.vColor3[0-5]:', geoColor[0], geoColor[1], geoColor[2]);
    }

    for (let i = 0; i < originalPositions.length; i += 3) {
        const origX = originalPositions[i];
        const origY = originalPositions[i + 1];
        const origZ = originalPositions[i + 2];

        const randX = randomPositions[i];
        const randY = randomPositions[i + 1];
        const randZ = randomPositions[i + 2];

        // 获取粒子颜色并计算亮度（用于凹凸区分）
        const r = particleColors[i];
        const g = particleColors[i + 1];
        const b = particleColors[i + 2];
        const brightness = (r + g + b) / 3;  // 0(黑) ~ 1(白)

        let currentX = origX * t + randX * (1 - t);
        let currentY = origY * t + randY * (1 - t);
        let currentZ = origZ * t + randZ * (1 - t);

        // ===== 整体波纹计算（基于粒子XY坐标，非随机种子）=====

        if (t < 0.5) {
            // 分散状态：以随机漂移为主，保留微弱整体波纹趋势
            const driftFactor = (1 - t / 0.5) * 0.7;
            const seed = i * 0.01;

            currentX += Math.sin(time * 0.8 + seed) * driftFactor;
            currentY += Math.cos(time * 0.6 + seed * 1.3) * driftFactor;

            // 弱化的整体波纹（让分散也有方向感）
            const weakRipple = calculateRipple(origX, origY, time, 0.25);
            currentZ += weakRipple * driftFactor * 0.5;

        } else {
            // ===== 核心：聚合状态的整体波纹系统 + 立体浮雕 =====

            // 波纹强度随聚合度增强
            const rippleFactor = (t - 0.5) / 0.5;  // 0 → 1
            let finalRippleStrength = baseRippleStrength * rippleFactor;

            // ===== 根据颜色亮度调整波纹振幅（浮雕效果）=====
            const depthModulation = calculateDepthFromBrightness(brightness);
            finalRippleStrength *= depthModulation;

            // ===== 基础立体深度（聚合状态时粒子不在同一平面）=====
            // 基于到中心的距离：边缘粒子略靠后，中心粒子略靠前
            const distFromCenter = Math.sqrt(origX * origX + origY * origY);
            const baseDepthFromDist = (distFromCenter / 12.0) * 1.2;  // 边缘向后凹陷
            
            // 基于亮度的基础深度：亮色凸起在前，暗色凹陷在后
            const brightnessDepth = (brightness - 0.5) * 2.5;  // -1.25 ~ +1.25
            
            // 综合基础Z偏移（即使完全聚合也有立体层次）
            const baseZOffset = (baseDepthFromDist + brightnessDepth) * 0.4 * t;

            // 计算多层叠加的整体波纹
            const totalRipple = calculateRipple(
                currentX,
                currentY,
                time,
                finalRippleStrength
            );

            // Z轴组成：插值位置 + 基础立体偏移 + 波纹起伏
            currentZ = currentZ + baseZOffset + totalRipple;

            // XY平面轻微跟随波纹倾斜（增强立体感）
            const tiltX = Math.cos(origX * 0.4 + time * 0.7) * 0.008 * rippleFactor * depthModulation;
            const tiltY = Math.sin(origY * 0.35 + time * 0.6) * 0.008 * rippleFactor * depthModulation;

            currentX += tiltX;
            currentY += tiltY;
        }

        positions[i] = currentX;
        positions[i + 1] = currentY;
        positions[i + 2] = currentZ;
    }

    particleGeometry.attributes.position.needsUpdate = true;
}

/**
 * 根据粒子颜色亮度计算深度调制系数
 * 实现浮雕效果：亮色凸起、暗色凹陷
 * @param {number} brightness - 粒子颜色亮度值 [0, 1]
 * @returns {number} 深度调制系数 (暗<1.0<亮)
 */
function calculateDepthFromBrightness(brightness) {
    // 亮度分段映射策略
    // 极暗(0~0.15): 强烈凹下 → 系数 0.3~0.5
    // 暗(0.15~0.35): 轻微凹下 → 系数 0.5~0.8
    // 中等(0.35~0.65): 正常基准 → 系数 0.9~1.1
    // 亮(0.65~0.85): 轻微凸起 → 系数 1.1~1.4
    // 极亮(0.85~1.0): 强烈凸起 → 系数 1.4~1.8

    let modulation;

    if (brightness < 0.15) {
        // 极暗区域：深凹陷（像山谷）
        modulation = 0.3 + (brightness / 0.15) * 0.2;  // 0.3 ~ 0.5
    } else if (brightness < 0.35) {
        // 暗区域：浅凹陷
        modulation = 0.5 + ((brightness - 0.15) / 0.2) * 0.3;  // 0.5 ~ 0.8
    } else if (brightness < 0.65) {
        // 中等亮度：接近正常（略微波动）
        const mid = (brightness - 0.35) / 0.3;  // 0 ~ 1
        // 使用平滑曲线：中间略低于两端，形成微妙对比
        modulation = 0.9 + Math.sin(mid * Math.PI) * 0.2;  // 0.9 ~ 1.1
    } else if (brightness < 0.85) {
        // 亮区域：轻微凸起（像小山丘）
        modulation = 1.1 + ((brightness - 0.65) / 0.2) * 0.3;  // 1.1 ~ 1.4
    } else {
        // 极亮区域：强烈凸起（像山峰）
        modulation = 1.4 + ((brightness - 0.85) / 0.15) * 0.4;  // 1.4 ~ 1.8
    }

    return modulation;
}

/**
 * 计算多层叠加的整体波纹偏移量
 * 基于粒子的XY坐标位置生成协调的波浪图案
 * @param {number} x - 粒子X坐标
 * @param {number} y - 粒子Y坐标
 * @param {number} time - 当前时间
 * @param {number} strength - 波纹强度系数
 * @returns {number} Z轴总偏移量
 */
function calculateRipple(x, y, time, strength) {
    // ===== 第一层：主横波（像旗帜从左到右飘动）=====
    const wave1Freq = 0.45;
    const wave1Speed = 0.9;
    const wave1Amp = 0.35;         // 振幅：1.2 → 0.35（降低70%）
    const wave1 = Math.sin(x * wave1Freq + time * wave1Speed) * wave1Amp;

    // ===== 第二层：副纵波（垂直方向的辅助波动）=====
    const wave2Freq = 0.38;
    const wave2Speed = 0.7;
    const wave2Amp = 0.22;         // 振幅：0.7 → 0.22（降低68%）
    const wave2 = Math.cos(y * wave2Freq + time * wave2Speed + Math.PI / 4) * wave2Amp;

    // ===== 第三层：对角线细波（增加表面细节）=====
    const wave3Freq = 0.85;
    const wave3Speed = 1.6;
    const wave3Amp = 0.10;         // 振幅：0.35 → 0.10（降低71%）
    const wave3 = Math.sin((x + y) * wave3Freq * 0.5 + time * wave3Speed) * wave3Amp;

    // ===== 第四层：径向圆环波（从中心向外扩散）=====
    const distFromCenter = Math.sqrt(x * x + y * y);
    const wave4Freq = 0.55;
    const wave4Speed = -1.2;
    const wave4Amp = 0.15;         // 振幅：0.5 → 0.15（降低70%）
    const wave4Decay = Math.exp(-distFromCenter * 0.08);
    const wave4 = Math.sin(distFromCenter * wave4Freq + time * wave4Speed) * wave4Amp * wave4Decay;

    // ===== 第五层：螺旋扭曲波（高级细节）=====
    const angle = Math.atan2(y, x);
    const spiralFreq = 0.3;
    const spiralSpeed = 0.5;
    const spiralAmp = 0.08;        // 振幅：0.25 → 0.08（降低68%）
    const wave5 = Math.sin(angle * 2.0 + distFromCenter * spiralFreq + time * spiralSpeed) * spiralAmp;

    // ===== 合成总波纹 =====
    const totalWave = (wave1 + wave2 + wave3 + wave4 + wave5) * strength;

    return totalWave;
}

/**
 * 更新飘散粒子位置
 * 根据滚动进度在聚合位置（深度柱）和分散位置之间插值
 * 聚合时粒子回到Z轴深度柱位置，分散时沿放射状飞散
 * 所有状态下都有持续的波纹和漂浮动画，避免粒子看起来静止
 */
function updateScatterPositions() {
    if (!scatterSystem || !scatterGeometry) return;
    if (!scatterOriginalPositions || !scatterRandomPositions) return;

    const positions = scatterGeometry.attributes.position.array;
    const time = clock.getElapsedTime();

    // 更新shader时间
    if (scatterMaterial && scatterMaterial.uniforms.time) {
        scatterMaterial.uniforms.time.value = time;
    }

    // 使用与主粒子相同的缓动进度
    const t = easeInOutCubic(currentScrollProgress);
    const count = positions.length / 3;

    // 获取飘散粒子当前帧颜色数据，用于亮度相关的浮雕深度调制
    const scatterColorAttr = scatterGeometry.attributes.vColor3;
    const colorArray = (scatterColorAttr && scatterFrameColors.length > 0) ? scatterColorAttr.array : null;

    // 波纹强度随聚合度增强
    const baseRippleStrength = 0.15 + t * 0.25;

    for (let i = 0; i < count; i++) {
        const idx = i * 3;
        const origX = scatterOriginalPositions[idx];
        const origY = scatterOriginalPositions[idx + 1];
        const origZ = scatterOriginalPositions[idx + 2];
        const randX = scatterRandomPositions[idx];
        const randY = scatterRandomPositions[idx + 1];
        const randZ = scatterRandomPositions[idx + 2];

        // 在聚合位置和分散位置之间插值
        let currentX = origX * t + randX * (1 - t);
        let currentY = origY * t + randY * (1 - t);
        let currentZ = origZ * t + randZ * (1 - t);

        // 深度柱粒子根据Z位置调整波纹强度
        const depthFade = 1.0 - Math.abs(origZ) * 0.05;
        const clampedDepthFade = Math.max(0.4, Math.min(1.0, depthFade));

        // ===== 根据颜色亮度调整波纹振幅（浮雕效果，与主粒子一致）=====
        let depthModulation = 1.0;
        let brightnessDepth = 0;
        if (colorArray) {
            const r = colorArray[idx];
            const g = colorArray[idx + 1];
            const b = colorArray[idx + 2];
            const brightness = (r + g + b) / 3;
            depthModulation = calculateDepthFromBrightness(brightness);
            brightnessDepth = (brightness - 0.5) * 2.5;  // -1.25 ~ +1.25
        }

        // ===== 始终生效的波纹动画 =====
        const ripple = calculateRipple(currentX, currentY, time, baseRippleStrength * clampedDepthFade * depthModulation);
        currentZ += ripple;

        // 基于亮度的基础深度偏移（亮色凸起、暗色凹陷）
        currentZ += brightnessDepth * 0.4 * t;

        // XY平面轻微跟随波纹倾斜
        const tiltStrength = 0.008 * clampedDepthFade * depthModulation;
        currentX += Math.cos(origX * 0.4 + time * 0.7) * tiltStrength;
        currentY += Math.sin(origY * 0.35 + time * 0.6) * tiltStrength;

        // 分散状态额外添加随机漂浮
        if (t < 0.5) {
            const driftFactor = (1 - t / 0.5) * 0.4;
            const seed = i * 0.73;
            currentX += Math.sin(time * 0.8 + seed) * driftFactor;
            currentY += Math.cos(time * 0.6 + seed * 1.3) * driftFactor;
            currentZ += Math.sin(time * 0.5 + seed * 0.7) * driftFactor * 0.5;
        }

        positions[idx] = currentX;
        positions[idx + 1] = currentY;
        positions[idx + 2] = currentZ;
    }

    scatterGeometry.attributes.position.needsUpdate = true;
}

/**
 * 三次方缓动函数
 * 实现平滑的非线性过渡效果
 * @param {number} t - 输入进度值 [0, 1]
 * @returns {number} 缓动后的值 [0, 1]
 */
function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 动画循环
 * 每帧更新滚动状态、粒子位置、旋转动画并渲染场景
 */
function animate() {
    requestAnimationFrame(animate);

    currentScrollProgress += (targetScrollProgress - currentScrollProgress) * 0.06;

    // 先更新 GIF 帧颜色，确保后续位置计算使用当帧颜色数据
    updateGifFrame(performance.now());

    updateParticlePositions();

    if (controls) {
        controls.update();
    }

    if (particleMaterial && particleMaterial.uniforms.time) {
        particleMaterial.uniforms.time.value = clock.getElapsedTime();
    }

    // 更新飘散粒子：轻微漂浮动画
    updateScatterPositions();

    composer.render();
}

/**
 * 初始化滚轮事件监听
 * 监听鼠标滚轮事件控制粒子的聚合/分散状态
 */
function initWheelControl() {
    window.addEventListener('wheel', function(event) {
        event.preventDefault();

        const delta = event.deltaY * 0.001;
        targetScrollProgress += delta;
        targetScrollProgress = Math.max(0, Math.min(1, targetScrollProgress));
    }, { passive: false });
}

/**
 * 打开右侧抽屉面板
 * 显示金色海报风格上传界面，隐藏触发按钮
 */
function openDrawer() {
    const drawer = document.getElementById('poster-drawer');
    const trigger = document.getElementById('drawer-trigger');

    trigger.classList.add('hidden');
    drawer.classList.add('open');
}

/**
 * 关闭右侧抽屉面板
 * 隐藏上传界面，显示触发按钮
 */
function closeDrawer() {
    const drawer = document.getElementById('poster-drawer');
    const trigger = document.getElementById('drawer-trigger');

    drawer.classList.remove('open');
    
    setTimeout(() => {
        trigger.classList.remove('hidden');
    }, 300);
}

/**
 * 更新状态显示文字
 * @param {string} text - 状态文本内容
 * @param {string} [type] - 状态类型: 'success' | 'default'
 */
function updateStatus(text, type) {
    const statusValue = document.getElementById('status-value');
    statusValue.textContent = text;
    
    if (type === 'success') {
        statusValue.classList.add('success');
    } else {
        statusValue.classList.remove('success');
    }
}

/**
 * 控制面板默认参数配置
 */
const DEFAULT_CONFIG = {
    bloomStrength: 1.8,
    bloomRadius: 0.4,
    bloomThreshold: 0.2,
    particleSize: 0.085,
    particleSpread: 20,
    glowDecay: 5.0,
    colorGlowMult: 1.8,
    coreBrightness: 0.8,
    flowGlowAmp: 0.06,
    fgGlowCoef: 0.05,
    pulseAmp: 0.015,
    depthFactor: 0.15,
    ambientIntensity: 0.7,
    point1Intensity: 2.2,
    point2Intensity: 1.5,
    fogDensity: 0.028,
    cameraZ: 16
};

/** localStorage 存储键名 */
const STORAGE_KEY = 'novaFragment_particleConfig';

/**
 * 从 localStorage 读取用户保存的配置
 * @returns {Object|null} 解析后的配置对象，无数据返回 null
 */
function loadStoredConfig() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.warn('读取本地配置失败:', e);
        return null;
    }
}

/**
 * 将当前所有滑块值写入 localStorage（自动防抖）
 * @param {boolean} [force=false] 是否强制立即写入（忽略防抖）
 */
let _saveTimer = null;
function saveToStorage(force = false) {
    if (_saveTimer) clearTimeout(_saveTimer);

    const doSave = () => {
        try {
            const config = {};
            Object.keys(DEFAULT_CONFIG).forEach(key => {
                const slider = document.getElementById(camelize(key));
                if (slider) config[key] = parseFloat(slider.value);
            });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        } catch (e) {
            console.warn('保存配置到本地失败:', e);
        }
    };

    if (force) {
        doSave();
    } else {
        _saveTimer = setTimeout(doSave, 300);
    }
}

/**
 * 将已存储的配置应用到滑块控件并触发回调
 * @param {Object} stored - 从 localStorage 读取的配置对象
 */
function applyStoredConfig(stored) {
    Object.entries(DEFAULT_CONFIG).forEach(([key, defaultVal]) => {
        const sliderId = camelize(key);
        const slider = document.getElementById(sliderId);
        if (!slider || stored[key] === undefined) return;

        const val = stored[key];
        // 边界保护：确保值在滑块 min/max 范围内
        const clamped = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), val));
        slider.value = clamped;

        const valEl = document.getElementById(sliderId + '-val');
        if (valEl) valEl.textContent = clamped;
    });
    // 触发一次 input 事件让所有绑定生效
    Object.keys(DEFAULT_CONFIG).forEach(key => {
        const slider = document.getElementById(camelize(key));
        if (slider) slider.dispatchEvent(new Event('input'));
    });
}

/**
 * 初始化左侧参数控制面板
 * 绑定所有滑块事件到对应的渲染参数
 */
function initControlPanel() {
    const panel = document.getElementById('control-panel');
    const toggleBtn = document.getElementById('ctrl-toggle');
    const expandTab = document.getElementById('ctrl-expand-tab');
    const resetBtn = document.getElementById('ctrl-reset');
    const exportBtn = document.getElementById('ctrl-export');

    // 头部按钮：收起面板
    toggleBtn.addEventListener('click', () => {
        panel.classList.add('collapsed');
        expandTab.classList.add('visible');
    });

    // 展开标签：展开面板
    expandTab.addEventListener('click', () => {
        panel.classList.remove('collapsed');
        expandTab.classList.remove('visible');
    });

    // 重置按钮：恢复默认并清除本地存储
    resetBtn.addEventListener('click', () => {
        Object.entries(DEFAULT_CONFIG).forEach(([key, val]) => {
            const slider = document.getElementById(camelize(key));
            if (slider) {
                slider.value = val;
                const valEl = document.getElementById(slider.id + '-val');
                if (valEl) valEl.textContent = val;
                slider.dispatchEvent(new Event('input'));
            }
        });
        localStorage.removeItem(STORAGE_KEY);
    });

    // 导出配置按钮
    exportBtn.addEventListener('click', () => {
        const config = {};
        Object.keys(DEFAULT_CONFIG).forEach(key => {
            const slider = document.getElementById(camelize(key));
            if (slider) config[key] = parseFloat(slider.value);
        });
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'particle-config.json';
        a.click();
        URL.revokeObjectURL(url);
    });

    // 绑定 Bloom 参数
    bindSlider('bloom-strength', (v) => { if (bloomPass) bloomPass.strength = v; });
    bindSlider('bloom-radius', (v) => { if (bloomPass) bloomPass.radius = v; });
    bindSlider('bloom-threshold', (v) => { if (bloomPass) bloomPass.threshold = v; });

    // 绑定粒子基础参数（需要重建粒子系统）
    bindSlider('particle-size', (v) => {
        window._particleSizeBase = v;
        rebuildParticleSizes();
    });
    bindSlider('particle-spread', (v) => {
        window._spreadFactor = v;
    });

    // 绑定 Shader Uniform 参数
    bindUniformSlider('glow-decay', 'uGlowDecay');
    bindUniformSlider('color-glow-mult', 'uColorGlowMult');
    bindUniformSlider('core-brightness', 'uCoreBrightness');
    bindUniformSlider('flow-glow-amp', 'uFlowGlowAmp');
    bindUniformSlider('fg-glow-coef', 'uFgGlowCoef');
    bindUniformSlider('pulse-amp', 'uPulseAmp');
    bindUniformSlider('depth-factor', 'uDepthFactor');

    // 绑定光照参数
    bindSlider('ambient-intensity', (v) => { if (ambientLight) ambientLight.intensity = v; });
    bindSlider('point1-intensity', (v) => { if (pointLight1) pointLight1.intensity = v; });
    bindSlider('point2-intensity', (v) => { if (pointLight2) pointLight2.intensity = v; });

    // 绑定场景参数
    bindSlider('fog-density', (v) => { if (scene && scene.fog) scene.fog.density = v; });
    bindSlider('camera-z', (v) => { if (camera) camera.position.z = v; });

    // 初始化粒子尺寸缓存
    window._particleSizeBase = PARTICLE_SIZE_BASE;
    window._spreadFactor = SPREAD_FACTOR;

    // ===== 所有绑定完成后，再加载并应用已保存的配置 =====
    const stored = loadStoredConfig();
    if (stored) {
        applyStoredConfig(stored);
    }
}

/**
 * 将滑块 ID 格式转换为 camelCase 配置键
 * @param {string} str - 滑块 ID（如 'bloom-strength'）
 * @returns {string} camelCase 键名（如 'bloomStrength'）
 */
function camelize(str) {
    return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * 绑定滑块控件到回调函数
 * 实时更新显示值、执行回调并自动保存到 localStorage
 * @param {string} id - 滑块元素 ID
 * @param {function} callback - 值变化时的回调函数
 */
function bindSlider(id, callback) {
    const slider = document.getElementById(id);
    const valEl = document.getElementById(id + '-val');
    if (!slider) return;

    slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        if (valEl) valEl.textContent = v;
        callback(v);
        saveToStorage();
    });
}

/**
 * 绑定滑块到 Shader Material 的 uniform 变量
 * @param {string} id - 滑块元素 ID
 * @param {string} uniformName - uniform 变量名
 */
function bindUniformSlider(id, uniformName) {
    bindSlider(id, (v) => {
        if (particleMaterial && particleMaterial.uniforms[uniformName]) {
            particleMaterial.uniforms[uniformName].value = v;
        }
    });
}

/**
 * 根据当前 particleSizeBase 重新计算并更新粒子大小属性
 * 需要在粒子系统创建后调用才有效
 */
function rebuildParticleSizes() {
    if (!particleGeometry || !particleColors || particleColors.length === 0) return;

    const base = window._particleSizeBase || PARTICLE_SIZE_BASE;
    const sizes = new Float32Array(particleColors.length / 3);

    for (let i = 0; i < particleColors.length; i += 3) {
        const r = particleColors[i];
        const g = particleColors[i + 1];
        const b = particleColors[i + 2];
        const brightness = (r + g + b) / 3;

        const brightnessFactor = 0.5 + brightness * 0.9;
        const randomScale = 0.6 + Math.random() * 0.8;
        sizes[i / 3] = base * brightnessFactor * randomScale;
    }

    particleGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
}

/**
 * 初始化应用
 * 设置事件监听器并启动渲染循环
 */
function init() {
    initScene();
    initWheelControl();
    initControlPanel();

    // 确保页面关闭/刷新前强制保存配置（解决防抖丢失问题）
    window.addEventListener('beforeunload', () => {
        saveToStorage(true);
    });

    const imageInput = document.getElementById('image-input');
    imageInput.addEventListener('change', handleImageUpload);

    const drawerTrigger = document.getElementById('drawer-trigger');
    drawerTrigger.addEventListener('click', openDrawer);

    const drawerOverlay = document.getElementById('drawer-overlay');
    drawerOverlay.addEventListener('click', closeDrawer);

    const drawerPanel = document.querySelector('.drawer-panel');
    drawerPanel.addEventListener('mouseleave', () => {
        setTimeout(() => {
            closeDrawer();
        }, 200);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const drawer = document.getElementById('poster-drawer');
            if (drawer.classList.contains('open')) {
                closeDrawer();
            }
        }
    });

    animate();
    console.log('🎬 3D彩色粒子图像效果已初始化');
    console.log('📁 点击右侧UPLOAD按钮打开上传面板');
    console.log('⌨ 快捷键: [1] 切换主粒子层 [2] 切换飘散粒子层 [3] 切换Bloom泛光');
}

/**
 * 初始化键盘快捷键
 * 用于隔离测试各渲染层
 */
window.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === '1') {
        if (window.particleSystem) {
            window.particleSystem.visible = !window.particleSystem.visible;
            console.log('[切换] 主粒子层:', window.particleSystem.visible ? '显示' : '隐藏');
        }
    } else if (e.key === '2') {
        if (window.scatterSystem) {
            window.scatterSystem.visible = !window.scatterSystem.visible;
            console.log('[切换] 飘散粒子层:', window.scatterSystem.visible ? '显示' : '隐藏');
        }
    } else if (e.key === '3') {
        if (bloomPass) {
            bloomPass.enabled = !bloomPass.enabled;
            console.log('[切换] Bloom泛光:', bloomPass.enabled ? '启用' : '禁用');
        }
    }
});

init();
