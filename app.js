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

let stream = null;
let facingMode = "environment";
let startedAt = null;
let timerId = null;
let poseModel = null;
let animationId = null;
let isPredicting = false;

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
  const frame = video.parentElement.getBoundingClientRect();
  const videoRatio = video.videoWidth / video.videoHeight;
  const frameRatio = frame.width / frame.height;
  let width;
  let height;

  if (videoRatio > frameRatio) {
    width = frame.width;
    height = width / videoRatio;
  } else {
    height = frame.height;
    width = height * videoRatio;
  }

  poseCanvas.width = video.videoWidth;
  poseCanvas.height = video.videoHeight;
  poseCanvas.style.width = `${width}px`;
  poseCanvas.style.height = `${height}px`;
  poseCanvas.style.left = `${(frame.width - width) / 2}px`;
  poseCanvas.style.top = `${(frame.height - height) / 2}px`;
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
  } else {
    poseStatus.textContent = "사람 찾는 중";
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
window.addEventListener("resize", resizePoseCanvas);
window.addEventListener("pagehide", () => stopCamera({ preserveMessage: true }));
updateCameraUi(false);
