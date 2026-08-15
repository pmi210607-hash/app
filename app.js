const video = document.querySelector("#cameraVideo");
const canvas = document.querySelector("#snapshotCanvas");
const emptyState = document.querySelector("#emptyState");
const liveIndicator = document.querySelector("#liveIndicator");
const cameraBadge = document.querySelector("#cameraBadge");
const cameraBadgeText = document.querySelector("#cameraBadgeText");
const monitorStatus = document.querySelector("#monitorStatus");
const elapsedTime = document.querySelector("#elapsedTime");
const facingText = document.querySelector("#facingText");
const message = document.querySelector("#message");

const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const switchButton = document.querySelector("#switchButton");
const captureButton = document.querySelector("#captureButton");

const captureSection = document.querySelector("#captureSection");
const capturePreview = document.querySelector("#capturePreview");
const downloadLink = document.querySelector("#downloadLink");

let stream = null;
let facingMode = "environment";
let startedAt = null;
let timerId = null;

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

function stopCamera({ preserveMessage = false } = {}) {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }

  stream = null;
  video.srcObject = null;
  stopTimer();
  updateCameraUi(false);

  if (!preserveMessage) {
    setMessage("카메라가 종료되었습니다. 다시 시작하려면 ‘카메라 시작’을 누르세요.");
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMessage("이 브라우저는 카메라 기능을 지원하지 않습니다. 최신 Chrome 또는 Edge를 사용해 주세요.", true);
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
    updateCameraUi(true);
    startTimer();
    facingText.textContent = facingMode === "environment" ? "후면 카메라" : "전면 카메라";
    setMessage("카메라가 정상적으로 작동하고 있습니다. 영상은 현재 브라우저에서만 표시됩니다.");

    const [videoTrack] = stream.getVideoTracks();
    videoTrack?.addEventListener("ended", () => stopCamera());
  } catch (error) {
    const messages = {
      NotAllowedError: "카메라 권한이 거부되었습니다. 주소창의 카메라 아이콘에서 권한을 허용해 주세요.",
      NotFoundError: "사용 가능한 카메라를 찾지 못했습니다. 카메라 연결 상태를 확인해 주세요.",
      NotReadableError: "다른 프로그램이 카메라를 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 시도해 주세요.",
      OverconstrainedError: "현재 카메라에서 요청한 촬영 조건을 사용할 수 없습니다.",
      SecurityError: "보안상 카메라를 실행할 수 없습니다. localhost 또는 HTTPS에서 실행해 주세요.",
    };

    stopCamera({ preserveMessage: true });
    setMessage(messages[error.name] ?? `카메라 실행 중 오류가 발생했습니다: ${error.message}`, true);
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

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const imageUrl = canvas.toDataURL("image/png");
  capturePreview.src = imageUrl;
  downloadLink.href = imageUrl;
  captureSection.hidden = false;
  captureSection.scrollIntoView({ behavior: "smooth", block: "start" });
  setMessage("현재 화면을 캡처했습니다. 아래에서 이미지를 저장할 수 있습니다.");
}

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", () => stopCamera());
switchButton.addEventListener("click", switchCamera);
captureButton.addEventListener("click", captureFrame);
window.addEventListener("pagehide", () => stopCamera({ preserveMessage: true }));

updateCameraUi(false);
