import { Engine, Render, Runner, World, Bodies, Body, Composite, Constraint, Sleeping } from 'matter-js';
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { saveAs } from 'file-saver';

// State
let engine, world, runner;
let strokes = []; // stores { body, color, thickness, isActive }
let activePaths = {}; // fingerName -> path

let videoElement, defaultCanvas, ctx;
let handLandmarker;
let lastVideoTime = -1;
let width, height;

// Options
let strokeSize = 14;
let strokeColor = '#CC5DE8';
let gravityEnabled = false;
let wiggleEnabled = false;

// Physics Config
const WALL_THICKNESS = 100;

async function init() {
    videoElement = document.getElementById('webcam');
    defaultCanvas = document.getElementById('output_canvas');
    ctx = defaultCanvas.getContext('2d');

    width = window.innerWidth;
    height = window.innerHeight;
    defaultCanvas.width = width;
    defaultCanvas.height = height;

    window.addEventListener('resize', () => {
        width = window.innerWidth;
        height = window.innerHeight;
        defaultCanvas.width = width;
        defaultCanvas.height = height;
        updateWalls();
    });

    // UI Setup
    setupUI();

    // Matter.js Setup
    engine = Engine.create({
        positionIterations: 8,
        velocityIterations: 8,
        enableSleeping: true
    });
    world = engine.world;
    engine.world.gravity.y = 0; // default off

    // Create Walls
    updateWalls();

    // Mediapipe
    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "GPU"
        },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    // Camera
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: 1280, height: 720 }
            });
            videoElement.srcObject = stream;
            videoElement.addEventListener('loadeddata', () => {
                videoElement.play();
                requestAnimationFrame(loop);
            });
        } catch (err) {
            console.warn("Camera permission denied.", err);
            // Fallback: still run loop for physics/rendering without video background
            requestAnimationFrame(loop);
        }
    }

    // Physics runner
    runner = Runner.create();
    Runner.run(runner, engine);
}

// Generate walls
let walls = [];
function updateWalls() {
    if (walls.length) {
        World.remove(world, walls);
        walls = [];
    }
    const options = { isStatic: true, friction: 0.8, restitution: 0.0 };
    walls.push(Bodies.rectangle(width / 2, height + WALL_THICKNESS / 2, width, WALL_THICKNESS, options));
    walls.push(Bodies.rectangle(width / 2, -WALL_THICKNESS / 2, width, WALL_THICKNESS, options));
    walls.push(Bodies.rectangle(-WALL_THICKNESS / 2, height / 2, WALL_THICKNESS, height, options));
    walls.push(Bodies.rectangle(width + WALL_THICKNESS / 2, height / 2, WALL_THICKNESS, height, options));
    World.add(world, walls);
}

function setupUI() {
    const strokeBtn = document.getElementById('stroke-btn');
    const strokePreview = document.getElementById('stroke-preview');

    strokeBtn.addEventListener('click', () => {
        let sizeStr = strokePreview.dataset.size;
        if (sizeStr === 'S') {
            sizeStr = 'M';
            strokeSize = 14;
            strokePreview.style.width = '14px';
            strokePreview.style.height = '14px';
        } else if (sizeStr === 'M') {
            sizeStr = 'L';
            strokeSize = 22;
            strokePreview.style.width = '22px';
            strokePreview.style.height = '22px';
        } else {
            sizeStr = 'S';
            strokeSize = 8;
            strokePreview.style.width = '8px';
            strokePreview.style.height = '8px';
        }
        strokePreview.dataset.size = sizeStr;
    });

    const picker = document.getElementById('color-picker');
    const preview = document.getElementById('color-preview');
    const hex = document.getElementById('color-hex');

    picker.addEventListener('input', (e) => {
        strokeColor = e.target.value.toUpperCase();
        preview.style.backgroundColor = strokeColor;
        hex.innerText = strokeColor;
    });

    const grav = document.getElementById('gravity-toggle');
    grav.addEventListener('change', (e) => {
        gravityEnabled = e.target.checked;
        engine.world.gravity.y = gravityEnabled ? 1 : 0;

        // Update all existing bodies
        strokes.forEach(s => {
            Body.setStatic(s.body, !gravityEnabled);
            if (gravityEnabled) {
                // Awake sleeping bodies
                Sleeping.set(s.body, false);
            } else {
                Body.setVelocity(s.body, { x: 0, y: 0 });
                Body.setAngularVelocity(s.body, 0);
            }
        });
    });

    const wig = document.getElementById('wiggle-toggle');
    wig.addEventListener('change', (e) => {
        wiggleEnabled = e.target.checked;
    });

    document.getElementById('clear-btn').addEventListener('click', () => {
        strokes.forEach(s => World.remove(world, s.body));
        strokes = [];
        activePaths = {};
    });

    document.getElementById('save-btn').addEventListener('click', () => {
        defaultCanvas.toBlob((blob) => {
            if (!blob) return;
            saveAs(blob, `handmotion-${Date.now()}.png`);
        }, 'image/png');
    });

    // Make UI Panel Draggable
    const uiPanel = document.getElementById('ui-panel');
    let isDraggingUI = false;
    let dragStartX = 0, dragStartY = 0;
    let panelStartX = 0, panelStartY = 0;

    const dragStart = (e) => {
        // Ignore inputs, labels, and buttons
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'LABEL' || e.target.tagName === 'A' || e.target.closest('.stroke-preview-container') || e.target.closest('.slider')) {
            return;
        }

        // Prevent default to stop text selection (the "blue stroke")
        if (e.type === 'mousedown') {
            e.preventDefault();
        }

        isDraggingUI = true;
        const event = e.touches ? e.touches[0] : e;
        dragStartX = event.clientX;
        dragStartY = event.clientY;

        const rect = uiPanel.getBoundingClientRect();
        panelStartX = rect.left;
        panelStartY = rect.top;

        // Reset bottom/transform styles explicitly on drag start to prevent CSS conflicts
        uiPanel.style.bottom = 'auto';
        uiPanel.style.transform = 'none';
        uiPanel.style.margin = '0';
        uiPanel.style.left = panelStartX + 'px';
        uiPanel.style.top = panelStartY + 'px';
    };

    const dragMove = (e) => {
        if (!isDraggingUI) return;

        if (e.type === 'touchmove') {
            e.preventDefault(); // prevent native scrolling while dragging
        }

        const event = e.touches ? e.touches[0] : e;
        const dx = event.clientX - dragStartX;
        const dy = event.clientY - dragStartY;
        uiPanel.style.left = Math.max(0, Math.min(window.innerWidth - uiPanel.offsetWidth, panelStartX + dx)) + 'px';
        uiPanel.style.top = Math.max(0, Math.min(window.innerHeight - uiPanel.offsetHeight, panelStartY + dy)) + 'px';
    };

    const dragEnd = () => {
        isDraggingUI = false;
    };

    uiPanel.addEventListener('mousedown', dragStart);
    window.addEventListener('mousemove', dragMove);
    window.addEventListener('mouseup', dragEnd);

    uiPanel.addEventListener('touchstart', dragStart, { passive: true });
    window.addEventListener('touchmove', dragMove, { passive: true });
    window.addEventListener('touchend', dragEnd);
}

// Math util
function distance(p1, p2) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

function processHand(results) {
    if (results.landmarks && results.landmarks.length > 0) {
        const hand = results.landmarks[0];
        const wrist = hand[0];

        // fingers to track: index, middle, ring, pinky
        const fingers = [
            { name: 'index', tip: hand[8], mcp: hand[5] },
            { name: 'middle', tip: hand[12], mcp: hand[9] },
            { name: 'ring', tip: hand[16], mcp: hand[13] },
            { name: 'pinky', tip: hand[20], mcp: hand[17] }
        ];

        fingers.forEach(finger => {
            const isExtended = distance(finger.tip, wrist) > distance(finger.mcp, wrist) * 1.5;

            if (isExtended) {
                const x = (1 - finger.tip.x) * width;
                const y = finger.tip.y * height;
                const point = { x, y };

                if (!activePaths[finger.name]) {
                    activePaths[finger.name] = [point];
                } else {
                    const currentPath = activePaths[finger.name];
                    const last = currentPath[currentPath.length - 1];
                    if (distance(last, point) > 2) {
                        currentPath.push(point);
                    }
                }
            } else {
                if (activePaths[finger.name]) {
                    finishStroke(activePaths[finger.name]);
                    delete activePaths[finger.name];
                }
            }
        });
    } else {
        // Hand lost, finish all
        Object.keys(activePaths).forEach(name => {
            finishStroke(activePaths[name]);
            delete activePaths[name];
        });
    }
}

// Convert drawn path `currentPath` into a Matter body
function finishStroke(path) {
    if (!path || path.length < 2) return;

    // Resample points so circles overlap properly
    // spacing around thickness / 3 for smooth collision boundary
    let spacing = strokeSize * 0.4;
    let resampled = [];
    resampled.push(path[0]);

    for (let i = 1; i < path.length; i++) {
        let p1 = resampled[resampled.length - 1];
        let p2 = path[i];
        let dist = distance(p1, p2);

        while (dist >= spacing) {
            let t = spacing / dist;
            let nx = p1.x + (p2.x - p1.x) * t;
            let ny = p1.y + (p2.y - p1.y) * t;
            let np = { x: nx, y: ny };
            resampled.push(np);
            p1 = np;
            dist = distance(p1, p2);
        }
    }

    // Create circular bodies for each resampled point
    // To avoid performance issues with huge lines, cap it or just rely on bounding
    let parts = resampled.map(p => {
        return Bodies.circle(p.x, p.y, strokeSize / 2);
    });

    // Single compound body
    let body = Body.create({
        parts: parts,
        isStatic: !gravityEnabled,
        friction: 0.9,     // higher friction to stop sliding
        frictionAir: 0.05, // more air friction to settle
        restitution: 0.0,  // absolutely no bouncy
        density: 0.1,      // heavier to settle fast
        slop: 0.05,
        render: { visible: false } // we render ourselves
    });

    World.add(world, body);
    strokes.push({
        body: body,
        color: strokeColor,
        thickness: strokeSize
    });
}

function loop(time) {
    // Render video
    if (videoElement && videoElement.readyState >= 2) {
        if (videoElement.currentTime !== lastVideoTime) {
            if (handLandmarker) {
                const results = handLandmarker.detectForVideo(videoElement, performance.now());
                processHand(results);
            }
            lastVideoTime = videoElement.currentTime;
        }

        ctx.save();
        ctx.scale(-1, 1);
        ctx.translate(-width, 0);
        // Use object-fit cover equivalent
        const vRatio = (width / height) > (videoElement.videoWidth / videoElement.videoHeight);
        let drawW = width, drawH = height, drawX = 0, drawY = 0;
        if (vRatio) {
            drawW = width;
            drawH = videoElement.videoHeight * (width / videoElement.videoWidth);
            drawY = (height - drawH) / 2;
        } else {
            drawH = height;
            drawW = videoElement.videoWidth * (height / videoElement.videoHeight);
            drawX = (width - drawW) / 2;
        }
        ctx.drawImage(videoElement, drawX, drawY, drawW, drawH);
        ctx.restore();
    } else {
        // Solid background fallback
        ctx.fillStyle = '#1D1D1F';
        ctx.fillRect(0, 0, width, height);
    }

    // Draw currently drawing paths
    const names = Object.keys(activePaths);
    if (names.length > 0) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeSize;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        names.forEach(name => {
            const path = activePaths[name];
            if (path.length > 0) {
                ctx.beginPath();
                for (let i = 0; i < path.length; i++) {
                    let p = path[i];
                    let x = p.x;
                    let y = p.y;
                    if (wiggleEnabled) {
                        x += Math.sin(time * 0.01 + y * 0.02) * 2;
                        y += Math.cos(time * 0.01 + x * 0.02) * 2;
                    }
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();

                // Draw spark at the finger tip
                let lastP = path[path.length - 1];
                let lx = lastP.x;
                let ly = lastP.y;
                if (wiggleEnabled) {
                    lx += Math.sin(time * 0.01 + ly * 0.02) * 2;
                    ly += Math.cos(time * 0.01 + lx * 0.02) * 2;
                }
                drawSpark(ctx, lx, ly, strokeColor, strokeSize, time);
            }
        });
    }

    // Draw physics strokes
    strokes.forEach(stroke => {
        // A compound body has body.parts (where parts[0] is the hull, parts[1..n] are the circles)
        // We connect the parts' positions to reconstruct the smooth path
        ctx.beginPath();
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.thickness;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        let parts = stroke.body.parts;
        let started = false;
        for (let i = 1; i < parts.length; i++) {
            let p = parts[i].position;
            let x = p.x;
            let y = p.y;
            if (wiggleEnabled) {
                x += Math.sin(time * 0.01 + y * 0.02) * 2;
                y += Math.cos(time * 0.01 + x * 0.02) * 2;
            }

            if (!started) {
                ctx.moveTo(x, y);
                started = true;
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
    });

    requestAnimationFrame(loop);
}

function drawSpark(ctx, x, y, color, size, time) {
    ctx.save();
    ctx.translate(x, y);

    // Center bright core
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#FFFFFF';

    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2);
    ctx.fill();

    // Reset shadow for the outer sparks
    ctx.shadowBlur = 15;
    ctx.shadowColor = color;
    ctx.lineCap = 'round';

    const numRays = 32;
    for (let i = 0; i < numRays; i++) {
        // Deterministic noise based on index to keep the sparks looking chaotic but stable
        let noiseAngle = Math.sin(i * 12.9898) * 43758.5453 % 1;
        let noiseLength = Math.sin(i * 78.233) * 43758.5453 % 1;

        // Angle with a little random offset
        let angle = (i / numRays) * Math.PI * 2 + (noiseAngle * 0.3);

        // Vibrate lengths with time
        let lengthMod = 0.7 + 0.3 * Math.sin(time * 0.02 + i * 2);
        let rayLength = size * (1.2 + 2.5 * Math.abs(noiseLength)) * lengthMod;

        // Twinkling effect: sometimes skip drawing a ray
        let blink = Math.sin(time * 0.015 + i * 1.5);
        if (blink < -0.5) continue;

        ctx.beginPath();
        // Start a bit away from center
        let startDist = size * (0.3 + 0.2 * Math.abs(noiseAngle));
        ctx.moveTo(Math.cos(angle) * startDist, Math.sin(angle) * startDist);
        ctx.lineTo(Math.cos(angle) * rayLength, Math.sin(angle) * rayLength);

        ctx.lineWidth = 0.5 + Math.abs(noiseLength) * 2;

        // Mix whites and primary color to look like real sparks
        if (i % 3 === 0) {
            ctx.strokeStyle = '#FFFFFF';
            ctx.globalAlpha = 0.9;
        } else {
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.6 + 0.4 * Math.abs(noiseAngle);
        }

        ctx.stroke();
        ctx.globalAlpha = 1.0;

        // Add scattered embers/dots floating at the tips
        if (i % 3 === 0) {
            let dotAngle = angle + (noiseAngle * 0.5);
            let dotDist = rayLength * (1.0 + 0.4 * Math.sin(time * 0.03 + i));
            ctx.fillStyle = (i % 2 === 0) ? '#FFFFFF' : color;
            ctx.beginPath();
            let dotSize = 0.5 + 1.5 * Math.abs(noiseLength);
            ctx.arc(Math.cos(dotAngle) * dotDist, Math.sin(dotAngle) * dotDist, dotSize, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    ctx.restore();
}

// Start
init();

