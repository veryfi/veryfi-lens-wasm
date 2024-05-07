import DeviceUUID from "./wasm/device-uuid.js";
import { WasmWrapper } from "./wasm/wasm.js";
import gatherBrowserData from "./wasm/device-data.js";
import UAParser from "./wasm/ua-parser.cjs";

const VeryfiLens = (function () {
  const DEFAULT_BOX_COlOR = "rgba(84, 192, 139, 0.6)";
  const DEFAULT_SCALE = 1.0;
  const INTERVAL = 250;
  const LENS_DEVICE_ID_SEPARATOR = "LENS_DEVICE_ID";
  const LENS_SESSION_KEY_SEPARATOR = "LENS_SESSION_KEY";
  const MAX_SHAPE = 512.0;
  const SOCKET_URL = "wss://lens.veryfi.com/ws/crop";
  const VALIDATE_URL = "https://lens.veryfi.com/rest/validate_partner";
  const PROCESS_URL = "https://lens.veryfi.com/rest/process";
  const wasmWrapper = new WasmWrapper();
  let creditCardStatus = "AutoCaptureResultWaiting";
  const SOCKET_STATUSES = [
    {
      value: 0,
      state: "CONNECTING",
    },
    {
      value: 1,
      state: "OPEN",
    },
    {
      value: 2,
      state: "CLOSING",
    },
    {
      value: 3,
      state: "CLOSED",
    },
    {
      value: -1,
      state: "UNDEFINED",
    },
  ];

  let boxRef = null;
  let cropImgRef = null;
  let frameRef = null;
  let videoRef = null;
  let intervalRef = null;
  let userAgent = null;
  let device_uuid = null;
  let fullSizeImage;
  // let wasmWrapper = null;
  let finalImage;

  let previewData = null;
  let boxColor = DEFAULT_BOX_COlOR;
  let clientId = "";
  let coordinates = [];
  let currentFrame = "";
  let isStitchingProcess = false;
  let isDocumentProcess = false;
  let isInitialized = false;
  let hasCoordinates = false;
  let hasInit = false;
  let image = "";
  let isDocument = false;
  let isSocketBusy = false;
  let lensSessionKey = "";
  let scale = DEFAULT_SCALE;
  let ws = null;
  let blurStatus = "";
  let variance;
  let shouldUpdatePreview = false;
  let CCPhase = "ScanningFront";
  let timeStamp = 0;
  let ShouldProcessCC = true;
  // let cv = null;
  let cvReady = false;

  let cardData = {
    status: "",
    name: "",
    number: "",
    date: "",
    cvv: "",
  };
  const releaseCanvas = (canvas) => {
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      ctx && ctx.clearRect(0, 0, 1, 1);
    }
  };

  const setClientId = (key) => {
    clientId = key;
  };

  const setCoordinates = (state) => {
    coordinates = state;
  };

  const setCurrentFrame = (state) => {
    currentFrame = state;
  };

  const setHasCoordinates = (state) => {
    hasCoordinates = state;
  };

  const setIsDocument = (state) => {
    isDocument = state;
  };

  const socketInitializer = async () => {
    const connectionId = Date.now();
    ws = new WebSocket(`${SOCKET_URL}/${connectionId}`);
    ws.onmessage = function (event) {
      const payload = JSON.parse(event.data);
      switch (payload.event) {
        case "connect":
          isSocketBusy = false;
          console.log("[EVENT] Started sending frames");
          break;
        case "cropped":
          isSocketBusy = false;
          console.log("[EVENT] Got cropped contours");
          if (payload.data.is_receipt === false) {
            const video = videoRef;
            let boxCanvas = boxRef;
            if (video && boxCanvas) {
              boxCanvas.width = video.videoWidth;
              boxCanvas.height = video.videoHeight;
              const ctx = boxCanvas.getContext("2d");
              if (ctx) ctx.restore();
            }
            setHasCoordinates(false);
            return;
          }
          const rCorners = payload.data.contours.map((corner) =>
            corner.map((cord) => cord / scale)
          );
          drawContours(rCorners);
          // coordinates = rCorners;
          break;
        default:
          isSocketBusy = false;
          console.log("[EVENT] Unknown event");
      }
    };
  };

  const displayVideo = () => {
    const video = videoRef;
    const frameCanvas = frameRef;
    if (video && frameCanvas) {
      frameCanvas.width = video.videoWidth;
      frameCanvas.height = video.videoHeight;
      const ctx = frameCanvas.getContext("2d");
      if (ctx) ctx.drawImage(video, 0, 0);
    }
  };

  const sendFrame = () => {
    if (isSocketBusy) return;
    const video = videoRef;
    const frameCanvas = frameRef;
    if (video && frameCanvas) {
      let videoHeight = Number(video.videoHeight);
      let videoWidth = Number(video.videoWidth);

      const fullSizeCanvas = document.createElement("canvas");
      fullSizeCanvas.width = videoWidth;
      fullSizeCanvas.height = videoHeight;
      const fullSizeCtx = fullSizeCanvas.getContext("2d");

      if (fullSizeCtx) {
        fullSizeCtx.save();
        fullSizeCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
        fullSizeCtx.restore();
        const imgString = fullSizeCanvas.toDataURL("image/jpeg");

        fullSizeImage = new Image();
        fullSizeImage.src = imgString;
      }

      if (videoWidth > videoHeight) {
        if (videoWidth > MAX_SHAPE) {
          scale = MAX_SHAPE / videoWidth;
          videoHeight = videoHeight * scale;
          videoWidth = MAX_SHAPE;
        }
      } else {
        if (videoHeight > MAX_SHAPE) {
          scale = MAX_SHAPE / videoHeight;
          videoWidth = videoWidth * scale;
          videoHeight = MAX_SHAPE;
        }
      }
      frameCanvas.width = videoWidth;
      frameCanvas.height = videoHeight;
      const ctx = frameCanvas.getContext("2d");

      if (ctx) {
        ctx.save();
        ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
        ctx.restore();
      }
      const imgString = frameCanvas.toDataURL("image/jpeg");
      const payload = imgString.split("data:image/jpeg;base64,")[1];
      setCurrentFrame(payload);

      if (ws.readyState === 1) {
        isSocketBusy = true;
        ws.send(
          getDeviceID(device_uuid) +
            LENS_DEVICE_ID_SEPARATOR +
            lensSessionKey +
            LENS_SESSION_KEY_SEPARATOR +
            payload
        );
      }
      releaseCanvas(frameCanvas);
    }
  };

  const getVideo = async () => {
    const isDesktop = window.screen.width > window.screen.height;
    const isAndroid = /Android/i.test(navigator.userAgent);

    if (navigator) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(
          (device) => device.kind === "videoinput"
        );

        let videoConfig = {
          aspectRatio: isDesktop ? 9 / 16 : 16 / 9,
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        };

        if (isAndroid) {
          // Attempt to choose the main camera only on Android devices
          const mainCameraDevice = videoDevices.find((device) =>
            device.label.includes("camera2 0")
          );
          if (mainCameraDevice) {
            console.log("Main camera found", mainCameraDevice.deviceId);
            videoConfig.deviceId = { exact: mainCameraDevice.deviceId };
          } else {
            console.log(
              'No camera with label "camera2 0" found, using default camera settings'
            );
            videoConfig.facingMode = "environment"; // Fallback to default camera
          }
        } else {
          // Non-Android devices use default camera settings
          console.log("Non-Android device, using default camera settings");
          videoConfig.facingMode = "environment";
        }

        await navigator.mediaDevices
          .getUserMedia({ video: videoConfig })
          .then((stream) => {
            console.log(
              videoConfig.deviceId
                ? "Started stream with main camera"
                : "Started stream with default camera"
            );
            const video = videoRef;
            video.srcObject = stream;
          })
          .catch((err) => {
            console.log(`[Event] Error: ${err}`);
          });
      } catch (error) {
        console.error("Error accessing the camera", error);
      }
    } else {
      console.log("No navigator available");
    }
  };

  const getVideoWasmLong = async () => {
    const isDesktop = window.screen.width > window.screen.height;
    const isAndroid = /Android/i.test(navigator.userAgent);

    if (navigator) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(
          (device) => device.kind === "videoinput"
        );

        let videoConfig = {
          aspectRatio: isDesktop ? 9 / 16 : 16 / 9,
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        };

        if (isAndroid) {
          // Attempt to choose the main camera only on Android devices
          const mainCameraDevice = videoDevices.find((device) =>
            device.label.includes("camera2 0")
          );
          if (mainCameraDevice) {
            console.log("Main camera found", mainCameraDevice.deviceId);
            videoConfig.deviceId = { exact: mainCameraDevice.deviceId };
          } else {
            console.log(
              'No camera with label "camera2 0" found, using default camera settings'
            );
            videoConfig.facingMode = "environment"; // Fallback to default camera
          }
        } else {
          // Non-Android devices use default camera settings
          console.log("Non-Android device, using default camera settings");
          videoConfig.facingMode = "environment";
        }

        await navigator.mediaDevices
          .getUserMedia({ video: videoConfig })
          .then((stream) => {
            console.log(
              videoConfig.deviceId
                ? "Started stream with main camera"
                : "Started stream with default camera"
            );
            const video = videoRef;
            video.srcObject = stream;
            wasmWrapper.setStitcherCallback(logLongDocument);
          })
          .catch((err) => {
            console.log(`[Event] Error: ${err}`);
          });
      } catch (error) {
        console.error("Error accessing the camera", error);
      }
    } else {
      console.log("No navigator available");
    }
  };

  const getVideoWasm = async () => {
    const isDesktop = window.screen.width > window.screen.height;
    const isAndroid = /Android/i.test(navigator.userAgent);

    if (navigator) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        console.log(devices);
        const videoDevices = devices.filter(
          (device) => device.kind === "videoinput"
        );

        let useMainCamera = false;
        let mainCameraDeviceId = null;
        if (isAndroid) {
          for (const device of videoDevices) {
            if (device.label.includes("camera2 0")) {
              console.log("Main camera found", device.deviceId);
              mainCameraDeviceId = device.deviceId;
              useMainCamera = true;
              break;
            }
          }
        }
        let videoConfig = {
          aspectRatio: isDesktop ? 9 / 16 : 16 / 9,
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        };

        if (useMainCamera) {
          videoConfig.deviceId = { exact: mainCameraDeviceId };
        } else {
          videoConfig.facingMode = "environment";
        }

        await navigator.mediaDevices
          .getUserMedia({ video: videoConfig })
          .then((stream) => {
            const video = videoRef;
            video.srcObject = stream;
            wasmWrapper.setDocumentCallback(logDocument);
          })
          .catch((err) => {
            console.log(`[Event] Error: ${err}`);
          });
      } catch (error) {
        console.error("Error accessing the camera", error);
      }
    } else {
      console.log("No navigator available");
    }
  };

  const getCCVideo = async () => {
    const isDesktop = window.screen.width > window.screen.height;
    const isAndroid = /Android/i.test(navigator.userAgent);

    if (navigator) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(
          (device) => device.kind === "videoinput"
        );

        let useMainCamera = false;
        let mainCameraDeviceId = null;
        if (isAndroid) {
          // Attempt to choose main camera only on Android
          for (const device of videoDevices) {
            if (device.label.includes("camera2 0")) {
              console.log("Main camera found", device.deviceId);
              mainCameraDeviceId = device.deviceId;
              useMainCamera = true;
              break;
            }
          }
        }
        let videoConfig = {
          aspectRatio: isDesktop ? 9 / 16 : 16 / 9,
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        };

        if (useMainCamera) {
          videoConfig.deviceId = { exact: mainCameraDeviceId };
        } else {
          videoConfig.facingMode = "environment";
        }
        await navigator.mediaDevices
          .getUserMedia({ video: videoConfig })
          .then((stream) => {
            const video = videoRef;
            video.srcObject = stream;
            wasmWrapper.setCardDetectorCallback(logCard);
          })
          .catch((err) => {
            console.log(`[Event] Error: ${err}`);
          });
      } catch (error) {
        console.error("Error accessing the camera", error);
      }
    } else {
      console.log("No navigator available");
    }
  };

  const loadImage = (src) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  };

  const sendWasm = async (mode) => {
    if (isDocumentProcess) {
      mode = "Document";
    } else if (isStitchingProcess) {
      mode = "Stitcher";
    } else mode = "StitcherProcess";
    if (videoRef) {
      let rCorners;
      const video = videoRef;
      let videoHeight = Number(video.videoHeight);
      let videoWidth = Number(video.videoWidth);
      const fullSizeCanvas = document.createElement("canvas");
      fullSizeCanvas.width = videoWidth;
      fullSizeCanvas.height = videoHeight;
      const fullSizeCtx = fullSizeCanvas.getContext("2d");

      if (fullSizeCtx) {
        fullSizeCtx.save();
        fullSizeCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
        fullSizeCtx.restore();
        const imgString = fullSizeCanvas.toDataURL("image/jpeg");

        try {
          fullSizeImage = await loadImage(imgString);
          createImageBitmap(fullSizeImage).then((bitmap) => {
            fullSizeImage = bitmap;
            wasmWrapper.processDocument(bitmap, mode);
            rCorners = coordinates.map((corner) =>
              corner.map((cord) => cord / scale)
            );
            if (
              rCorners.length &&
              rCorners.some((subArr) => subArr.reduce((a, b) => a + b, 0) !== 0)
            ) {
              drawContours(rCorners);
              if (previewData !== null && shouldUpdatePreview) {
                updatePreview(
                  previewData.data,
                  previewData.outputWidth,
                  previewData.outputHeight
                );
              }
            } else {
              setHasCoordinates(false);
              image = imgString;
            }
          });
        } catch (error) {
          console.log(error);
        }

        releaseCanvas(fullSizeCanvas);
        releaseCanvas(boxRef);
      }
    }
  };

  const sendCardWasm = async () => {
    if (!ShouldProcessCC) return;
    if (CCPhase == "FlipCard") {
      console.log("PHASE 3");
      if (timeStamp === 0) {
        console.log("Set Time");
        timeStamp = Date.now();
      }

      if (Date.now() - timeStamp > 3000) {
        console.log("Changing to phase 2");
        CCPhase = "ScanningBack";
        timeStamp = 0;
      }
      return;
    }
    if (cardData.status == "AutoCaptureResultDone") return;
    if (!videoRef) return;
    if (cardData.status != "AutoCaptureResultDone") {
      const video = videoRef;
      let videoHeight = video.videoHeight;
      let videoWidth = video.videoWidth;
      const fullSizeCanvas = document.createElement("canvas");
      fullSizeCanvas.width = videoWidth;
      fullSizeCanvas.height = videoHeight;
      const fullSizeCtx = fullSizeCanvas.getContext("2d");

      if (fullSizeCtx) {
        fullSizeCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
        const imgString = fullSizeCanvas.toDataURL("image/jpeg");
        try {
          const fullSizeImage = await loadImage(imgString);

          createImageBitmap(fullSizeImage).then((bitmap) => {
            // console.log(bitmap)
            wasmWrapper.processFrame(bitmap);
          });
        } catch (error) {
          console.error("Error loading image for card processing:", error);
        }
        fullSizeCanvas.remove();
      }
    }
  };

  const getLongImage = async () => {
    let wasmOutput;
    let imgString;
    if (hasCoordinates) {
      wasmOutput = await wasmWrapper.getStitchedImage();
      const { data, blurLevel, outputHeight, outputWidth } = wasmOutput;
      // console.log(blurLevel)
      const width = outputWidth;
      const height = outputHeight;
      const cropImgCanvas = cropImgRef;
      cropImgRef.height = height;
      cropImgRef.width = width;
      const ctx = cropImgCanvas.getContext("2d");
      const imageData = new ImageData(data, width, height);
      ctx.putImageData(imageData, 0, 0);
      imgString = cropImgCanvas.toDataURL("image/jpeg");
      image = cropImgCanvas;
    } else {
      console.log(isDocument);
      imgString = image;
    }
    // setBlurStatus(blurLevel); gives 0 all the time
    stopWasm();
    releaseCanvas(boxRef);
    coordinates = [];
    return imgString.split("data:image/jpeg;base64,")[1];
  };

  function updatePreview(data, originalWidth, originalHeight) {
    shouldUpdatePreview = false;
    const container = document.getElementById("preview-container");
    let width;
    let height;
    if (container) {
      width = container.clientWidth;
      height = container.clientHeight;
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = width;
    canvas.height = height;

    // Create a temporary canvas to draw the original image
    const tempCanvas = document.createElement("canvas");
    const tempContext = tempCanvas.getContext("2d");
    tempCanvas.width = originalWidth;
    tempCanvas.height = originalHeight;

    // Create the original ImageData and draw it to the temporary canvas
    let originalImageData = new ImageData(data, originalWidth, originalHeight);
    tempContext.putImageData(originalImageData, 0, 0);

    // Draw the image from the temporary canvas to the main canvas, resizing it in the process
    context.drawImage(
      tempCanvas,
      0,
      0,
      originalWidth,
      originalHeight,
      0,
      0,
      width,
      height
    );
    if (container) {
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
    }
    if (container) container.appendChild(canvas);
  }

  function logDocument(detectorResult, corners, nDocs) {
    console.log(
      `Detector Result: ${detectorResult}, Documents Detected: ${nDocs}`
    );
    for (let i = 0; i < nDocs; i++) {
      const offset = i * 4;
      coordinates = [
        [corners[offset].x, corners[offset].y],
        [corners[offset + 1].x, corners[offset + 1].y],
        [corners[offset + 2].x, corners[offset + 2].y],
        [corners[offset + 3].x, corners[offset + 3].y],
      ];
    }
  }

  function logLongDocument(stitcherResult, corners, nDocs, preview) {
    coordinates = corners.map((corner) => [corner.x, corner.y]);
    previewData = preview;
    shouldUpdatePreview = stitcherResult === 0;
  }

  const logCard = (status, name, number, date, cvv) => {
    const newData = wasmWrapper.parseCreditCardCallback(
      status,
      name,
      number,
      date,
      cvv
    );

    creditCardStatus = status;
    console.log(newData);
    Object.keys(newData).forEach((key) => {
      // Check also for empty string along with undefined and null
      if (
        newData[key] !== undefined &&
        newData[key] !== null &&
        newData[key] !== ""
      ) {
        cardData[key] = newData[key];
      }
    });
    console.log("card status", cardData.status);
    if (cardData.status == "AutoCaptureResultDone") {
      console.log("SWITCHING", CCPhase);
      switch (CCPhase) {
        case "ScanningFront":
          console.log("ITS CASE 1");
          cardData.status = "";
          CCPhase = "FlipCard";
        case "ScanningBack":
          console.log("ITS CASE 2");
          const scanForNumber = !cardData.number;
          const scanForName = !cardData.name;
          const scanForDate = !cardData.date;
          const scanForCvv = !cardData.cvv;
          wasmWrapper.resetAutoCapture(
            scanForNumber,
            scanForName,
            scanForDate,
            scanForCvv
          );
          if (cardData.status == "AutoCaptureResultDone") {
            ShouldProcessCC = false;
            wasmWrapper.resetAutoCapture(true, true, true, true);
            wasmWrapper.releaseCallback();
          }
      }
    }
  };

  const drawContours = (contours) => {
    const video = videoRef;
    const BoxCanvas = boxRef;

    if (video && BoxCanvas) {
      BoxCanvas.width = video.videoWidth;
      BoxCanvas.height = video.videoHeight;
      let ctx = BoxCanvas.getContext("2d");

      if (ctx) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(contours[0][0], contours[0][1]);
        ctx.lineTo(contours[1][0], contours[1][1]);
        ctx.lineTo(contours[2][0], contours[2][1]);
        ctx.lineTo(contours[3][0], contours[3][1]);
        ctx.fillStyle = boxColor;
        ctx.fill();
        setCoordinates(contours);
        setHasCoordinates(true);
        ctx.restore();
      }
    }
  };

  const cropWasm = async () => {
    let wasmOutput;
    if (hasCoordinates) {
      wasmOutput = await wasmWrapper.cropDocument(fullSizeImage);
    } else {
      // If there are no coordinates, use the fullSizeImage as it is.
      const canvas = new OffscreenCanvas(
        fullSizeImage.width,
        fullSizeImage.height
      );
      const ctx = canvas.getContext("2d");
      ctx.drawImage(fullSizeImage, 0, 0);
      const imageData = ctx.getImageData(
        0,
        0,
        fullSizeImage.width,
        fullSizeImage.height
      );
      wasmOutput = {
        data: new Uint8ClampedArray(imageData.data.buffer),
        blurLevel: -1.0,
        outputWidth: fullSizeImage.width,
        outputHeight: fullSizeImage.height,
      };
    }
    const { data, blurLevel, outputHeight, outputWidth } = wasmOutput;
    // console.log("out", wasmOutput);
    const width = outputWidth;
    const height = outputHeight;
    const cropImgCanvas = cropImgRef;
    cropImgRef.height = height;
    cropImgRef.width = width;
    const ctx = cropImgCanvas.getContext("2d");
    const imageData = new ImageData(data, width, height);
    ctx.putImageData(imageData, 0, 0);
    setBlurStatus(blurLevel);
    stopWasm();

    const imgString = cropImgCanvas.toDataURL("image/jpeg");
    image = cropImgCanvas;
    releaseCanvas(boxRef);
    coordinates = [];
    return imgString.split("data:image/jpeg;base64,")[1];
  };

  const cropImage = async () => {
    const video = videoRef;
    const cropImgCanvas = cropImgRef;
    if (fullSizeImage) {
      console.log("[Event] Full size image is set");
      if (hasCoordinates) {
        setIsDocument(true);
        let { sx, sy, sw, sh } = getCropLimits(coordinates);
        const scaleWidth = fullSizeImage.width / video.videoWidth;
        const scaleHeight = fullSizeImage.height / video.videoHeight;

        sx = sx * scaleWidth;
        sy = sy * scaleHeight;
        sw = sw * scaleWidth;
        sh = sh * scaleHeight;

        cropImgCanvas.width = sw;
        cropImgCanvas.height = sh;
        const ctx = cropImgCanvas.getContext("2d");

        if (ctx) {
          ctx.save();
          ctx.drawImage(fullSizeImage, sx, sy, sw, sh, 0, 0, sw, sh);
          ctx.restore();
        }
      } else {
        cropImgCanvas.width = video.videoWidth;
        cropImgCanvas.height = video.videoHeight;
        const ctx = cropImgCanvas.getContext("2d");
        if (ctx) {
          ctx.save();
          ctx.drawImage(fullSizeImage, 0, 0);
          ctx.restore();
        }
      }
    } else {
      if (hasCoordinates) {
        setIsDocument(true);
        let { sx, sy, sw, sh } = getCropLimits(coordinates);
        cropImgCanvas.width = sw;
        cropImgCanvas.height = sh;
        const ctx = cropImgCanvas.getContext("2d");
        if (ctx) {
          ctx.save();
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
          ctx.restore();
        }
      } else {
        cropImgCanvas.width = video.videoWidth;
        cropImgCanvas.height = video.videoHeight;
        const ctx = cropImgCanvas.getContext("2d");
        if (ctx) {
          ctx.save();
          ctx.drawImage(video, 0, 0);
          ctx.restore();
        }
      }
    }

    waitForElement("#blur-detector").then(() => {
      isBlurry(cropImgCanvas);
    });

    image = cropImgCanvas;
    const imgString = cropImgCanvas.toDataURL("image/jpeg");

    return imgString.split("data:image/jpeg;base64,")[1];
  };

  const socketCropWasm = async () => {
    let wasmOutput;
    if (hasCoordinates) {
      let [topLeft, topRight, bottomLeft, bottomRight] =
        getCropLimits(coordinates);
      wasmOutput = await wasmWrapper.cropWasm(
        fullSizeImage,
        [topLeft, topRight, bottomLeft, bottomRight].flat()
      );
    } else {
      // If there are no coordinates, use the fullSizeImage as it is.
      console.log("[Event] Using full size image");
      const canvas = new OffscreenCanvas(
        fullSizeImage.width,
        fullSizeImage.height
      );
      const ctx = canvas.getContext("2d");
      ctx.drawImage(fullSizeImage, 0, 0);
      const imageData = ctx.getImageData(
        0,
        0,
        fullSizeImage.width,
        fullSizeImage.height
      );
      wasmOutput = {
        data: new Uint8ClampedArray(imageData.data.buffer),
        blurLevel: 0.0,
        outputWidth: fullSizeImage.width,
        outputHeight: fullSizeImage.height,
      };
    }

    const { data, blurLevel, outputHeight, outputWidth } = wasmOutput;
    const width = outputWidth;
    const height = outputHeight;
    const cropImgCanvas = cropImgRef;
    cropImgRef.height = height;
    cropImgRef.width = width;
    const ctx = cropImgCanvas.getContext("2d");
    const imageData = new ImageData(data, width, height);
    ctx.putImageData(imageData, 0, 0);
    setBlurStatus(blurLevel);

    stopWasm();

    const imgString = cropImgCanvas.toDataURL("image/jpeg");
    image = cropImgCanvas;
    releaseCanvas(boxRef);
    coordinates = [];
    return imgString.split("data:image/jpeg;base64,")[1];
  };

  const getCropLimits = (coordinates) => {
    const sx = Math.min(
      coordinates[0][0],
      coordinates[1][0],
      coordinates[2][0],
      coordinates[3][0]
    );
    const sy = Math.min(
      coordinates[0][1],
      coordinates[1][1],
      coordinates[2][1],
      coordinates[3][1]
    );
    const sw =
      Math.max(
        coordinates[0][0],
        coordinates[1][0],
        coordinates[2][0],
        coordinates[3][0]
      ) - sx;
    const sh =
      Math.max(
        coordinates[0][1],
        coordinates[1][1],
        coordinates[2][1],
        coordinates[3][1]
      ) - sy;

    const topLeft = [sx, sy];
    const topRight = [sx + sw, sy];
    const bottomLeft = [sx, sy + sh];
    const bottomRight = [sx + sw, sy + sh];
    return { sx, sy, sw, sh };
    // return [topLeft, topRight, bottomLeft, bottomRight];
  };

  const fetchSessionId = async (clientId) => {
    return await fetch(VALIDATE_URL, {
      method: "POST",
      headers: {
        "CLIENT-ID": clientId,
      },
    })
      .then((response) => {
        if (response.ok) {
          return response.json();
        }
        throw new Error("Wrong client id");
      })
      .then((response) => {
        return response.session;
      })
      .catch((error) => {
        console.log("[EVENT] " + error);
      });
  };

  const stopLens = () => {
    ws.close();
    videoRef.srcObject.getTracks().forEach((track) => track.stop());
    clearInterval(intervalRef);
  };

  const stopWasm = () => {
    videoRef && videoRef.srcObject.getTracks().forEach((track) => track.stop());
    clearInterval(intervalRef);
  };

  const createElement = (type, id, classes, container) => {
    const element = document.createElement(type);
    element.setAttribute("id", id);
    element.className += classes;
    container.appendChild(element);
  };

  const getDeviceID = (uuid) => {
    return `${uuid}`.replace(/\-/g, "");
  };

  const startWasm = async (client_id) => {
    if (!wasmWrapper.loaded) {
      await wasmWrapper.initialize(client_id);
    }
    if (wasmWrapper) {
      getVideoWasm();
      requestAnimationFrame(displayVideo);
      intervalRef = setInterval(() => {
        sendWasm("Document");
      }, INTERVAL);
      return () => {
        clearInterval(intervalRef);
      };
    }
  };

  const startWasmLong = async (client_id) => {
    if (!wasmWrapper.loaded) {
      await wasmWrapper.initialize(client_id);
    }
    if (wasmWrapper) {
      getVideoWasmLong();
      requestAnimationFrame(displayVideo);
      intervalRef = setInterval(() => {
        sendWasm("StitcherProcess");
      }, INTERVAL);
      return () => {
        clearInterval(intervalRef);
      };
    }
  };

  const startLens = async () => {
    await socketInitializer().then(() => {
      console.log("[EVENT] Socket Initialized");
    });
    getVideo();
    requestAnimationFrame(displayVideo);
    intervalRef = setInterval(() => {
      requestAnimationFrame(sendFrame);
    }, INTERVAL);
    return () => {
      clearInterval(intervalRef);
    };
  };

  const startUploadWasm = async (client_id) => {
    await wasmWrapper.initialize(client_id);
    if (wasmWrapper) {
     await wasmWrapper.setDocumentCallback(logDocument);
    }
  };

  const startWasmCC = async (client_id) => {
    if (!wasmWrapper.loaded) {
      await wasmWrapper.initialize(client_id);
    }
    if (wasmWrapper.loaded) {
      getCCVideo();
      requestAnimationFrame(displayVideo);
      intervalRef = setInterval(() => {
        if (
          cardData.status === "AutoCaptureResultDone" &&
          CCPhase === "ScanningBack"
        ) {
          clearInterval(intervalRef); // Stop sending frames once condition is met
        } else {
          sendCardWasm();
        }
      }, INTERVAL);
    }
  };

  const setBlurStatus = (variance) => {
    if (variance >= 9) {
      blurStatus = false;
      return { blurStatus, variance };
    } else if (variance < 0) {
      blurStatus = false;
      console.log(
        "Variance is lower than 0, Which means image was not cropped and did not pass through blur detection"
      );
      return { blurStatus, variance };
    } else {
      blurStatus = true;
      return { blurStatus, variance };
    }
  };

  function loadOpenCv(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = () => resolve(); // Correctly scoped resolve
      script.onerror = () => reject(new Error(`Script load error for ${url}`));
      document.body.appendChild(script);
      cvReady = true;
    });
  }

  const isBlurry = async (image) => {
    console.log("[EVENT] Checking for blur");

    const src = cv.imread(image);
    let refVariance;
    let whiteCanvas = new cv.Mat(490, 866, cv.CV_8UC3, [255, 255, 255, 0]);

    const grayscale = new cv.Mat();
    const refGrayscale = new cv.Mat();

    cv.cvtColor(src, grayscale, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(whiteCanvas, refGrayscale, cv.COLOR_RGBA2GRAY);

    const laplacian = new cv.Mat();
    const refLaplacian = new cv.Mat();

    cv.Laplacian(grayscale, laplacian, cv.CV_8U);
    cv.Laplacian(refGrayscale, refLaplacian, cv.CV_8U);

    const meanStdDev = new cv.Mat();
    const laplacianMean = new cv.Mat();
    const refMeanStdDev = new cv.Mat();
    const refLaplacianMean = new cv.Mat();

    cv.meanStdDev(laplacian, laplacianMean, meanStdDev);
    cv.meanStdDev(refLaplacian, refLaplacianMean, refMeanStdDev);

    variance = meanStdDev.data64F[0];
    refVariance = refMeanStdDev.data64F[0];

    // console.log("variance", variance);
    // console.log("reference variance", refVariance);

    grayscale.delete();
    laplacian.delete();
    meanStdDev.delete();
    laplacianMean.delete();
    refGrayscale.delete();
    refLaplacian.delete();
    refMeanStdDev.delete();
    refLaplacianMean.delete();
    whiteCanvas.delete();
    setBlurStatus(variance);

    return;
  };

  const createElementWithStyles = (tag, id, styles, parent) => {
    const element = document.createElement(tag);
    element.id = id;
    Object.assign(element.style, styles);
    parent.appendChild(element);
    return element;
  };

  const createCanvases = () => {
    const container = document.getElementById("veryfi-container");

    const generalStyles = {
      position: "absolute",
      height: "100%",
      maxWidth: "500px",
      // aspectRatio: "16/9",
    };

    cropImgRef = createElementWithStyles(
      "canvas",
      "veryfi-crop-img-ref",
      { ...generalStyles, zIndex: 30 },
      container
    );
    frameRef = createElementWithStyles(
      "canvas",
      "veryfi-frame-ref",
      { display: "none" },
      container
    );
    videoRef = createElementWithStyles(
      "video",
      "veryfi-video-ref",
      generalStyles,
      container
    );
    boxRef = createElementWithStyles(
      "canvas",
      "veryfi-box-ref",
      { ...generalStyles, zIndex: 10 },
      container
    );
  };

  const flattenObject = (obj, parentKey = "", result = {}) => {
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        let propName = parentKey ? parentKey + "_" + key : key;

        if (
          typeof obj[key] === "object" &&
          obj[key] !== null &&
          !Array.isArray(obj[key])
        ) {
          flattenObject(obj[key], propName, result);
        } else {
          result[propName] = obj[key];
        }
      }
    }
    return result;
  };

  const parseUA = () => {
    const userAgentString = navigator.userAgent;
    const parser = new UAParser(userAgentString);
    let parserResults = parser.getResult && parser.getResult();
    if (parserResults) {
      return parserResults;
    }
  };

  const getBrowserData = () => {
    const browserData = gatherBrowserData();
    return browserData;
  };

  const waitForElement = (selector) => {
    return new Promise((resolve) => {
      if (document.querySelector(selector)) {
        return resolve(document.querySelector(selector));
      }

      const observer = new MutationObserver((mutations) => {
        if (document.querySelector(selector)) {
          resolve(document.querySelector(selector));
          observer.disconnect();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
  };

  return {
    init: async (session, client_id) => {
      userAgent = navigator.userAgent;
      device_uuid = new DeviceUUID(userAgent).get();
      console.log("[EVENT] Device ID", getDeviceID(device_uuid));
      if (session) {
        if (!cvReady) {
          loadOpenCv("./wasm/opencv.js");
        }
        lensSessionKey = session;
        createCanvases();
        videoRef = document.getElementById("veryfi-video-ref");
        const video = videoRef;
        video.playsInline = true;
        video.preload = "metadata";
        video.autoplay = true;
        frameRef = document.getElementById("veryfi-frame-ref");
        boxRef = document.getElementById("veryfi-box-ref");
        cropImgRef = document.getElementById("veryfi-crop-img-ref");
        if (client_id) {
          startLens();
        } else {
          console.log("No client id provided");
          return;
        }
      } else {
        console.log("No session token provided");
        return;
      }
    },

    initWasm: async (session, client_id) => {
      isDocumentProcess = true;
      userAgent = navigator.userAgent;
      device_uuid = new DeviceUUID(userAgent).get();

      if (session) {
        lensSessionKey = session;
        createCanvases();
        videoRef = document.getElementById("veryfi-video-ref");
        const video = videoRef;
        video.playsInline = true;
        video.preload = "metadata";
        video.autoplay = true;
        frameRef = document.getElementById("veryfi-frame-ref");
        boxRef = document.getElementById("veryfi-box-ref");
        cropImgRef = document.getElementById("veryfi-crop-img-ref");
        if (client_id) {
          startWasm(client_id);
        } else {
          console.log("No client id provided");
          return;
        }
      } else {
        console.log("No session token provided");
        return;
      }
    },

    initWasmLong: async (session, client_id) => {
      isStitchingProcess = false;
      userAgent = navigator.userAgent;
      device_uuid = new DeviceUUID(userAgent).get();

      if (session) {
        lensSessionKey = session;
        createCanvases();
        videoRef = document.getElementById("veryfi-video-ref");
        const video = videoRef;
        video.playsInline = true;
        video.preload = "metadata";
        video.autoplay = true;
        frameRef = document.getElementById("veryfi-frame-ref");
        boxRef = document.getElementById("veryfi-box-ref");
        cropImgRef = document.getElementById("veryfi-crop-img-ref");
        if (client_id) {
          startWasmLong(client_id);
        } else {
          console.log("No client id provided");
          return;
        }
      } else {
        console.log("No session token provided");
        return;
      }
    },

    initUploadWasm: async (session, client_id) => {
      if (session) {
        userAgent = navigator.userAgent;
        device_uuid = new DeviceUUID(userAgent).get();
        if (client_id) {
          await startUploadWasm(client_id);
        } else {
          console.log("No client id provided");
          return;
        }
      } else {
        console.log("No session token provided");
        return;
      }
    },

    initCC: async (session, client_id) => {
      isDocumentProcess = true;
      userAgent = navigator.userAgent;
      device_uuid = new DeviceUUID(userAgent).get();
      ShouldProcessCC = true;
      CCPhase = "ScanningFront";
      cardData = { status: "", number: "", name: "", date: "", cvv: "" };

      if (session) {
        lensSessionKey = session;
        const container = document.getElementById("veryfi-container");
        const generalClasses = "absolute sm:rounded-md h-full max-w-none";
        createElement(
          "video",
          "veryfi-video-ref",
          `${generalClasses} z-10`,
          container
        );

        videoRef = document.getElementById("veryfi-video-ref");
        const video = videoRef;
        video.playsInline = true;
        video.preload = "metadata";
        video.autoplay = true;
        frameRef = document.getElementById("veryfi-frame-ref");
        boxRef = document.getElementById("veryfi-box-ref");
        if (client_id) {
          startWasmCC(client_id);
        } else {
          console.log("No client id provided");
          return;
        }
      } else {
        console.log("No session token provided");
        return;
      }
    },

    startCamera: () => {
      console.log("[EVENT] startCamera");
      startLens();
    },

    startCameraWasm: () => {
      console.log("[EVENT] startCamera");
      startWasm();
    },

    stopCamera: () => {
      console.log("[EVENT] stopCamera");
      stopLens();
      clearInterval(intervalRef);
    },

    stopCameraWasm: () => {
      console.log("[EVENT] stopCamera");
      stopWasm();
      clearInterval(intervalRef);
    },

    getCardData: async () => {
      return cardData;
    },

    capture: async (setImage, setIsEditing) => {
      console.log("[EVENT] capture");
      const finalImage = await cropImage();
      setImage && setImage(finalImage);
      console.log("[EVENT] hasCoordinates: ", hasCoordinates);
      if (hasCoordinates) setIsDocument(true);
      stopLens();
      setIsEditing && setIsEditing(true);
      return finalImage;
    },

    captureWasm: async (setImage, setIsEditing) => {
      console.log("[EVENT] capture wasm");
      // console.log("[EVENT] hasCoordinates: ", hasCoordinates);
      if (hasCoordinates) setIsDocument(true);
      finalImage = await cropWasm();
      setImage && setImage(finalImage);
      stopWasm();
      wasmWrapper.releaseCallback();
      setIsEditing && setIsEditing(true);
      return finalImage;
    },

    captureLong: async (setImage, setIsEditing) => {
      console.log("[EVENT] capture long");
      finalImage = await getLongImage();
      setImage && setImage(finalImage);
      stopWasm();
      if (hasCoordinates) setIsDocument(true);
      wasmWrapper.releaseCallback();
      setIsEditing && setIsEditing(true);
      return finalImage;
    },

    captureUploaded: async (imageData) => {
      return await createImageBitmap(imageData).then(async (bitmap) => {
        const wasmOutput = await wasmWrapper.cropDocument(bitmap);
        const { data, blurLevel, outputHeight, outputWidth } = wasmOutput;
        // console.log(outputWidth, outputHeight, "output")

        if (outputWidth > 0 && outputHeight > 0) {
          const width = outputWidth;
          const height = outputHeight;
          const cropImgCanvas = document.createElement("canvas");
          cropImgCanvas.height = height;
          cropImgCanvas.width = width;
          const ctx = cropImgCanvas.getContext("2d");
          const imageData = new ImageData(data, width, height);
          ctx.putImageData(imageData, 0, 0);
          setBlurStatus(blurLevel);
          wasmWrapper.releaseCallback()
          const imgString = cropImgCanvas.toDataURL("image/jpeg");
          image = cropImgCanvas;
          setIsDocument(true);
          coordinates = [];
          return imgString.split("data:image/jpeg;base64,")[1];
        } else {
          // Return the original, uncropped image
          return new Promise((resolve, reject) => {
            setIsDocument(false);
            const reader = new FileReader();
            reader.readAsDataURL(imageData);
            reader.onload = function () {
              const base64Image = reader.result.split(",")[1];
              resolve(base64Image);
            };
            reader.onerror = function (error) {
              reject(error);
            };
            // stopWasm()
          });
        }
      });
    },

    startStitching: async () => {
      isStitchingProcess = true;
    },

    createNewSession: async (clientId) => {
      await fetchSessionId(clientId);
      setClientId(clientId);
    },

    setUserAgent: (ua) => {
      userAgent = ua;
    },

    getBoxColor: () => {
      return boxColor;
    },

    setBoxColor: (color) => {
      boxColor = color;
    },

    getCroppedImage: () => {
      return image;
    },

    getCoordinates: () => {
      return coordinates;
    },

    getHasCoordinates: () => {
      return hasCoordinates;
    },

    getHasInit: () => {
      return hasInit;
    },

    getIsDocument: () => {
      return isDocument;
    },

    getLensSessionKey: () => {
      return lensSessionKey;
    },

    setLensSessionKey: (key) => {
      lensSessionKey = key;
    },

    getSocketStatus: () => {
      const value = ws.readyState || 4;
      return SOCKET_STATUSES[value];
    },

    getSocketStatusColor: () => {
      const socketStatusesColors = [
        "yellow",
        "green",
        "orange",
        "red",
        "purple",
      ];

      const value = ws.readyState || 4;
      return socketStatusesColors[value];
    },

    getBlurStatus: (setIsBlurry) => {
      setIsBlurry && setIsBlurry(blurStatus);
      return {
        blurStatus,
        variance,
      };
    },

    cleanCanvases: () => {
      console.log("Cleaning");
      const box = boxRef;
      const video = videoRef;
      const frame = frameRef;
      const crop = cropImgRef;
      crop && releaseCanvas(crop);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      box && releaseCanvas(box);
      frame && releaseCanvas(frame);
      videoRef && videoRef.remove();
      frameRef && frameRef.remove();
      boxRef && boxRef.remove();
      cropImgRef && cropImgRef.remove();
      // wasmWrapper && wasmWrapper.release();
      setIsDocument(false);
    },

    getDeviceData: async () => {
      if (!device_uuid) {
        userAgent = navigator.userAgent;
        device_uuid = new DeviceUUID(userAgent).get();
      }
      const browserData = await getBrowserData();
      const UAData = flattenObject(parseUA());

      return {
        browser_fingerprint: { ...UAData, ...browserData },
        uuid: device_uuid,
        source: "lens.web",
      };
    },

    getCardPhase: () => {
      return CCPhase;
    },
    releaseWasm: () => {
      wasmWrapper.release();
    }
  };
})();

export default VeryfiLens;
