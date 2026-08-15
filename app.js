const $ = (selector) => document.querySelector(selector);
const video = $("#cameraVideo");
const poseCanvas = $("#poseCanvas");
const poseContext = poseCanvas.getContext("2d");
const snapshotCanvas = $("#snapshotCanvas");
const emptyState = $("#emptyState");
const liveIndicator = $("#liveIndicator");
const cameraBadge = $("#cameraBadge");
const cameraBadgeText = $("#cameraBadgeText");
const monitorStatus = $("#monitorStatus");
const poseStatus = $("#poseStatus");
const elapsedTime = $("#elapsedTime");
const facingText = $("#facingText");
const message = $("#message");
const startButton = $("#startButton");
const stopButton = $("#stopButton");
const switchButton = $("#switchButton");
const captureButton = $("#captureButton");
const captureSection = $("#captureSection");
const capturePreview = $("#capturePreview");
const downloadLink = $("#downloadLink");
const movementChart = $("#movementChart");
const movementScoreText = $("#movementScore");
const rhythmScoreText = $("#rhythmScore");
const repeatCountText = $("#repeatCount");
const dominantPartText = $("#dominantPart");
const analysisBadge = $("#analysisBadge");

let stream = null;
let facingMode = "environment";
let startedAt = null;
let timerId = null;
let poseModel = null;
let animationId = null;
let isPredicting = false;
let previousLandmarks = null;
let lastAnalysisAt = 0;
let repeatEvents = 0;
let wasRhythmHigh = false;
const analysisData = [];
const motionWindow = [];

const BODY_GROUPS = {
  "왼팔": [11, 13, 15, 17, 19, 21],
  "오른팔": [12, 14, 16, 18, 20, 22],
  "몸통": [11, 12, 23, 24],
  "왼다리": [23, 25, 27, 29, 31],
  "오른다리": [24, 26, 28, 30, 32],
};
const TRACKED_JOINTS = [...new Set(Object.values(BODY_GROUPS).flat())];
const SAMPLE_INTERVAL = 200;
const RHYTHM_THRESHOLD = 65;

function formatElapsed(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function updateCameraUi(isOn) {
  cameraBadge.dataset.state = isOn ? "on" : "off";
  cameraBadgeText.textContent = isOn ? "카메라 작동 중" : "카메라 꺼짐";
  monitorStatus.textContent = isOn ? "실시간 관찰 중" : "관찰 대기 중";
  emptyState.hidden = isOn;
  liveIndicator.hidden = !isOn;
  startButton.disabled = isOn;
  stopButton.disabled = !isOn;
  switchButton.disabled = !isOn;
  captureButton.disabled = !isOn;
}

function startTimer() {
  startedAt = Date.now();
  elapsedTime.textContent = "00:00:00";
  clearInterval(timerId);
  timerId = setInterval(() => {
    elapsedTime.textContent = formatElapsed(Date.now() - startedAt);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
  startedAt = null;
}

function resizePoseCanvas() {
  if (!video.videoWidth || !video.videoHeight) return;
  poseCanvas.width = video.videoWidth;
  poseCanvas.height = video.videoHeight;
}

async function loadPoseModel() {
  if (poseModel) return;
  poseStatus.textContent = "모델 준비 중";
  if (typeof Pose === "undefined") {
    throw new Error("MediaPipe Pose 스크립트를 불러오지 못했습니다.");
  }

  poseModel = new Pose({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
  });
  poseModel.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  poseModel.onResults(drawPoseResults);
  await poseModel.initialize();
  poseStatus.textContent = "AI 준비 완료";
}

function clearPoseCanvas() {
  poseContext.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
}

function landmarkDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function visible(point) {
  return point && (point.visibility ?? 1) >= 0.45;
}

function calculateRhythmScore() {
  const values = motionWindow.filter((item) => !item.ignored).map((item) => item.value);
  if (values.length < 15) return 0;
  const recent = values.slice(-30);
  const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  if (mean < 3) return 0;

  let bestCorrelation = 0;
  for (let lag = 2; lag <= Math.min(10, Math.floor(recent.length / 2)); lag += 1) {
    const a = recent.slice(lag);
    const b = recent.slice(0, recent.length - lag);
    const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
    const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
    let numerator = 0;
    let varianceA = 0;
    let varianceB = 0;
    for (let i = 0; i < a.length; i += 1) {
      const da = a[i] - meanA;
      const db = b[i] - meanB;
      numerator += da * db;
      varianceA += da * da;
      varianceB += db * db;
    }
    const correlation = numerator / Math.sqrt(varianceA * varianceB || 1);
    bestCorrelation = Math.max(bestCorrelation, correlation);
  }
  return Math.round(Math.max(0, Math.min(100, bestCorrelation * 100)));
}

function analyzeLandmarks(landmarks) {
  const now = performance.now();
  if (now - lastAnalysisAt < SAMPLE_INTERVAL) return;
  lastAnalysisAt = now;

  if (!previousLandmarks) {
    previousLandmarks = landmarks.map((point) => ({ ...point }));
    return;
  }

  const shoulderWidth = Math.max(landmarkDistance(landmarks[11], landmarks[12]), 0.08);
  const jointMovements = {};
  let movingJointCount = 0;

  for (const index of TRACKED_JOINTS) {
    const current = landmarks[index];
    const previous = previousLandmarks[index];
    if (!visible(current) || !visible(previous)) continue;
    const normalized = (landmarkDistance(current, previous) / shoulderWidth) * 100;
    jointMovements[index] = normalized;
    if (normalized > 5) movingJointCount += 1;
  }

  const values = Object.values(jointMovements);
  const movement = values.length
    ? Math.min(100, values.reduce((sum, value) => sum + value, 0) / values.length * 2)
    : 0;

  const torsoIndices = [11, 12, 23, 24];
  const torsoMovement = torsoIndices
    .map((index) => jointMovements[index] ?? 0)
    .reduce((sum, value) => sum + value, 0) / torsoIndices.length;
  const widespreadRatio = movingJointCount / TRACKED_JOINTS.length;
  const ignoredAsTurn = torsoMovement > 7 && widespreadRatio > 0.55;

  let dominantPart = "-";
  let dominantValue = 0;
  for (const [name, indices] of Object.entries(BODY_GROUPS)) {
    const groupValues = indices.map((index) => jointMovements[index]).filter(Number.isFinite);
    const groupMean = groupValues.length
      ? groupValues.reduce((sum, value) => sum + value, 0) / groupValues.length
      : 0;
    if (groupMean > dominantValue) {
      dominantValue = groupMean;
      dominantPart = name;
    }
  }

  motionWindow.push({ value: movement, ignored: ignoredAsTurn });
  if (motionWindow.length > 40) motionWindow.shift();
  const rhythm = ignoredAsTurn ? 0 : calculateRhythmScore();

  if (rhythm >= RHYTHM_THRESHOLD && !wasRhythmHigh) repeatEvents += 1;
  wasRhythmHigh = rhythm >= RHYTHM_THRESHOLD;

  analysisData.push({
    movement: Math.round(movement),
    rhythm,
    ignored: ignoredAsTurn,
  });
  if (analysisData.length > 300) analysisData.shift();

  movementScoreText.textContent = String(Math.round(movement));
  rhythmScoreText.textContent = String(rhythm);
  repeatCountText.textContent = `${repeatEvents}회`;
  dominantPartText.textContent = dominantValue > 1 ? dominantPart : "-";

  if (ignoredAsTurn) {
    analysisBadge.textContent = "뒤척임 제외";
    analysisBadge.dataset.state = "ignored";
  } else if (rhythm >= RHYTHM_THRESHOLD) {
    analysisBadge.textContent = "반복 움직임 확인 필요";
    analysisBadge.dataset.state = "warning";
  } else {
    analysisBadge.textContent = movement > 3 ? "움직임 분석 중" : "안정";
    analysisBadge.dataset.state = "normal";
  }

  previousLandmarks = landmarks.map((point) => ({ ...point }));
  drawMovementChart();
}

function resetMovementAnalysis() {
  previousLandmarks = null;
  lastAnalysisAt = 0;
  repeatEvents = 0;
  wasRhythmHigh = false;
  analysisData.length = 0;
  motionWindow.length = 0;
  movementScoreText.textContent = "0";
  rhythmScoreText.textContent = "0";
  repeatCountText.textContent = "0회";
  dominantPartText.textContent = "-";
  analysisBadge.textContent = "분석 대기";
  analysisBadge.dataset.state = "waiting";
  drawMovementChart();
}

function drawMovementChart() {
  const context = movementChart.getContext("2d");
  const rect = movementChart.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(rect.width, 300);
  const height = Math.max(rect.height, 180);
  movementChart.width = width * dpr;
  movementChart.height = height * dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const padding = { left: 38, right: 12, top: 16, bottom: 28 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xAt = (index) => padding.left + (index / 299) * plotWidth;
  const yAt = (value) => padding.top + plotHeight - (value / 100) * plotHeight;

  context.font = "11px sans-serif";
  context.fillStyle = "#7a879b";
  context.strokeStyle = "#dfe6ef";
  context.lineWidth = 1;
  for (const value of [0, 25, 50, 75, 100]) {
    const y = yAt(value);
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillText(String(value), 8, y + 4);
  }

  const startIndex = 300 - analysisData.length;
  analysisData.forEach((item, index) => {
    if (!item.ignored) return;
    const x = xAt(startIndex + index);
    context.fillStyle = "#aeb8c733";
    context.fillRect(x - 1, padding.top, Math.max(2, plotWidth / 300 + 1), plotHeight);
  });

  context.setLineDash([6, 5]);
  context.strokeStyle = "#e59f24";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(padding.left, yAt(RHYTHM_THRESHOLD));
  context.lineTo(width - padding.right, yAt(RHYTHM_THRESHOLD));
  context.stroke();
  context.setLineDash([]);

  function drawSeries(key, color) {
    context.strokeStyle = color;
    context.lineWidth = 2.5;
    context.beginPath();
    analysisData.forEach((item, index) => {
      const x = xAt(startIndex + index);
      const y = yAt(item[key]);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }

  drawSeries("movement", "#1f69c1");
  drawSeries("rhythm", "#e6534b");
  context.fillStyle = "#7a879b";
  context.fillText("-60초", padding.left, height - 8);
  context.fillText("현재", width - padding.right - 24, height - 8);
}

function drawPoseResults(results) {
  clearPoseCanvas();
  if (results.poseLandmarks) {
    poseStatus.textContent = "사람 감지됨 · 33개 점";
    drawConnectors(poseContext, results.poseLandmarks, POSE_CONNECTIONS, {
      color: "#44e3ff",
      lineWidth: 4,
    });
    drawLandmarks(poseContext, results.poseLandmarks, {
      color: "#ff5b65",
      fillColor: "#ffec57",
      lineWidth: 2,
      radius: 5,
    });
    analyzeLandmarks(results.poseLandmarks);
  } else {
    poseStatus.textContent = "사람 찾는 중";
    previousLandmarks = null;
  }
}

async function predictPose() {
  if (!stream || !poseModel) return;
  if (!isPredicting && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    isPredicting = true;
    try {
      await poseModel.send({ image: video });
    } catch (error) {
      poseStatus.textContent = "AI 분석 오류";
      console.error("MediaPipe frame error:", error);
    } finally {
      isPredicting = false;
    }
  }
  animationId = requestAnimationFrame(predictPose);
}

function stopCamera({ preserveMessage = false } = {}) {
  if (animationId) cancelAnimationFrame(animationId);
  animationId = null;
  isPredicting = false;
  clearPoseCanvas();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  stopTimer();
  updateCameraUi(false);
  poseStatus.textContent = poseModel ? "AI 준비 완료" : "모델 준비 전";
  if (!preserveMessage) setMessage("카메라가 종료되었습니다. 다시 시작하려면 ‘카메라 시작’을 누르세요.");
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMessage("카메라를 사용할 수 없습니다. HTTPS 주소에서 최신 Chrome 또는 Edge를 사용해 주세요.", true);
    return;
  }
  stopCamera({ preserveMessage: true });
  resetMovementAnalysis();
  setMessage("카메라 권한을 요청하고 있습니다...");

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    resizePoseCanvas();
    updateCameraUi(true);
    startTimer();
    facingText.textContent = facingMode === "environment" ? "후면 카메라" : "전면 카메라";
    setMessage("카메라가 작동 중입니다. AI 자세 인식 모델을 준비하고 있습니다...");
    stream.getVideoTracks()[0]?.addEventListener("ended", () => stopCamera());

    try {
      await loadPoseModel();
      if (!stream) return;
      setMessage("AI가 사람의 33개 신체 지점을 실시간으로 분석하고 있습니다.");
      predictPose();
    } catch (aiError) {
      poseStatus.textContent = "AI 불러오기 실패";
      setMessage("카메라는 정상 작동 중이지만 AI 모델을 불러오지 못했습니다. 인터넷 연결 후 새로고침해 주세요.", true);
      console.error("Pose model load failed:", aiError);
    }
  } catch (error) {
    const messages = {
      NotAllowedError: "카메라 권한이 거부되었습니다. 주소창의 카메라 아이콘에서 권한을 허용해 주세요.",
      NotFoundError: "사용 가능한 카메라를 찾지 못했습니다.",
      NotReadableError: "다른 프로그램이 카메라를 사용 중입니다.",
      SecurityError: "localhost 또는 HTTPS 주소에서 실행해 주세요.",
    };
    stopCamera({ preserveMessage: true });
    poseStatus.textContent = poseModel ? "AI 준비 완료" : "모델 준비 전";
    setMessage(messages[error.name] ?? `실행 중 오류가 발생했습니다: ${error.message}`, true);
  }
}

async function switchCamera() {
  facingMode = facingMode === "environment" ? "user" : "environment";
  await startCamera();
}

function captureFrame() {
  if (!stream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    setMessage("캡처할 수 있는 카메라 화면이 없습니다.", true);
    return;
  }
  snapshotCanvas.width = video.videoWidth;
  snapshotCanvas.height = video.videoHeight;
  const context = snapshotCanvas.getContext("2d");
  context.drawImage(video, 0, 0);
  context.drawImage(poseCanvas, 0, 0);
  const imageUrl = snapshotCanvas.toDataURL("image/png");
  capturePreview.src = imageUrl;
  downloadLink.href = imageUrl;
  captureSection.hidden = false;
  captureSection.scrollIntoView({ behavior: "smooth", block: "start" });
  setMessage("관절점이 표시된 현재 화면을 캡처했습니다.");
}

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", () => stopCamera());
switchButton.addEventListener("click", switchCamera);
captureButton.addEventListener("click", captureFrame);
window.addEventListener("resize", () => {
  resizePoseCanvas();
  drawMovementChart();
});
window.addEventListener("pagehide", () => stopCamera({ preserveMessage: true }));
updateCameraUi(false);
drawMovementChart();
