import DeviceUUID from "./wasm/device-uuid.js";
import { WasmWrapper } from "./wasm/wasm.js";
import gatherBrowserData from "./wasm/device-data.js";
import UAParser from "./wasm/parser-wrapper.js";

const VeryfiLens = (function () {
  const DEFAULT_BOX_COlOR = "rgba(84, 192, 139, 0.6)";
  const INTERVAL = 250;
  const VALIDATE_URL = "https://lens.veryfi.com/rest/validate_partner";
  const wasmWrapper = new WasmWrapper();
  let creditCardStatus = "AutoCaptureResultWaiting";

  let boxRef = null;
  let cropImgRef = null;
  let frameRef = null;
  let videoRef = null;
  let intervalRef = null;
  let userAgent = null;
  let device_uuid = null;
  let torchTrack = null;
  let fullSizeImage;
  let finalImage;

  let previewData = null;
  let boxColor = DEFAULT_BOX_COlOR;
  let clientId = "";
  let coordinates = [];
  let currentFrame = "";
  let isStitchingProcess = false;
  let isDocumentProcess = false;
  let hasCoordinates = false;
  let hasInit = false;
  let image = "";
  let isDocument = false;
  let lensSessionKey = "";
  let blurStatus = "";
  let variance;
  let shouldUpdatePreview = false;
  let CCPhase = "ScanningFront";
  let timeStamp = 0;
  let ShouldProcessCC = true;

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
          advanced: [{ torch: true }],
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
        torchTrack = stream.getVideoTracks()[0];
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
          advanced: [{ torch: true }],
        };

        if (useMainCamera) {
          videoConfig.deviceId = { exact: mainCameraDeviceId };
        } else {
          videoConfig.facingMode = "environment";
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConfig,
        });
        const video = videoRef;
        video.srcObject = stream;
        wasmWrapper.setDocumentCallback(logDocument);

        // Store the video track for torch control
        torchTrack = stream.getVideoTracks()[0];
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
          advanced: [{ torch: true }],
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
            torchTrack = stream.getVideoTracks()[0];
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

  const getChecksVideo = async () => {
    const isDesktop =
      !/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      );
    const isAndroid = /Android/i.test(navigator.userAgent);
    const isLandscape = window.innerWidth > window.innerHeight;

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
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          advanced: [{ torch: true }],
        };

        if (isDesktop) {
          // Force portrait mode for desktop
          videoConfig.aspectRatio = 9 / 16;
        } else {
          // For mobile, adapt to device orientation
          videoConfig.aspectRatio = isLandscape ? 16 / 9 : 9 / 16;
        }

        if (useMainCamera) {
          videoConfig.deviceId = { exact: mainCameraDeviceId };
        } else {
          videoConfig.facingMode = "environment";
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConfig,
        });
        const video = videoRef;
        video.srcObject = stream;
        wasmWrapper.setDocumentCallback(logDocument);

        // Add event listener to handle orientation changes on mobile
        if (!isDesktop) {
          window.addEventListener("orientationchange", async () => {
            const isNewLandscape = window.innerWidth > window.innerHeight;
            videoConfig.aspectRatio = isNewLandscape ? 16 / 9 : 9 / 16;
            const newStream = await navigator.mediaDevices.getUserMedia({
              video: videoConfig,
            });
            video.srcObject = newStream;
          });
        }
        torchTrack = stream.getVideoTracks()[0];
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

  const toggleTorchLight = async () => {
    if (torchTrack) {
      const capabilities = torchTrack.getCapabilities();
      if (capabilities.torch) {
        try {
          await torchTrack.applyConstraints({
            advanced: [
              { torch: !torchTrack.getConstraints().advanced?.[0]?.torch },
            ],
          });
        } catch (err) {
          console.error("Error toggling torch:", err);
        }
      } else {
        console.log("Torch not supported on this device");
      }
    } else {
      console.log("Camera not initialized");
    }
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
      let videoHeight = video.videoHeight;
      let videoWidth = video.videoWidth;
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
            rCorners = coordinates.map((corner) => corner);
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
    if (nDocs > 0) {
      for (let i = 0; i < nDocs; i++) {
        const offset = i * 4;
        const coordinates = [
          [corners[offset].x, corners[offset].y],
          [corners[offset + 1].x, corners[offset + 1].y],
          [corners[offset + 2].x, corners[offset + 2].y],
          [corners[offset + 3].x, corners[offset + 3].y],
        ];

        // Call drawContours with the obtained coordinates
        drawContours(coordinates);
      }
    } else {
      // No documents detected, clear the canvas
      drawContours([]);
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

      if (ctx && contours && contours.length === 4) {
        ctx.clearRect(0, 0, BoxCanvas.width, BoxCanvas.height);
        ctx.save();
        ctx.beginPath();

        const scaleX = BoxCanvas.width / video.videoWidth;
        const scaleY = BoxCanvas.height / video.videoHeight;

        // Calculate the bounding box of the contours
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        contours.forEach(([x, y]) => {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        });

        // Expand the bounding box slightly to ensure 100% coverage
        const expandFactor = 1;
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        minX = centerX - (centerX - minX) * expandFactor;
        maxX = centerX + (maxX - centerX) * expandFactor;
        minY = centerY - (centerY - minY) * expandFactor;
        maxY = centerY + (maxY - centerY) * expandFactor;

        // Ensure the expanded box doesn't go outside the canvas
        minX = Math.max(0, minX * scaleX);
        minY = Math.max(0, minY * scaleY);
        maxX = Math.min(BoxCanvas.width, maxX * scaleX);
        maxY = Math.min(BoxCanvas.height, maxY * scaleY);

        // Draw the expanded rectangle
        ctx.moveTo(minX, minY);
        ctx.lineTo(maxX, minY);
        ctx.lineTo(maxX, maxY);
        ctx.lineTo(minX, maxY);
        ctx.closePath();

        ctx.fillStyle = boxColor;
        ctx.fill();

        // Update coordinates with the expanded box
        setCoordinates([
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
        ]);
        setHasCoordinates(true);
        ctx.restore();
      } else {
        // Handle the case where no valid contours are provided
        ctx.clearRect(0, 0, BoxCanvas.width, BoxCanvas.height);
        setCoordinates([]);
        setHasCoordinates(false);
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

    image = cropImgCanvas;
    const imgString = cropImgCanvas.toDataURL("image/jpeg");

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

  const startUploadWasm = async (client_id) => {
    await wasmWrapper.initialize(client_id);
    if (wasmWrapper) {
      wasmWrapper.setDocumentCallback(logDocument);
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

  const startWasmChecks = async (client_id) => {
    if (!wasmWrapper.loaded) {
      await wasmWrapper.initialize(client_id);
    }
    if (wasmWrapper) {
      getChecksVideo();
      requestAnimationFrame(displayVideo);
      intervalRef = setInterval(() => {
        sendWasm("Document");
      }, INTERVAL);
      return () => {
        clearInterval(intervalRef);
      };
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

  const createCheckCanvases = () => {
    const container = document.getElementById("veryfi-container");
    let isDesktop = window.innerWidth >= 1024;

    const setElementStyles = (element, styles) => {
      Object.assign(element.style, styles);
    };

    const createElementWithStyles = (tag, id, styles, parent) => {
      const element = document.createElement(tag);
      element.id = id;
      setElementStyles(element, styles);
      parent.appendChild(element);
      return element;
    };

    const updateElementsSize = () => {
      isDesktop = window.innerWidth >= 1024;
      const isPortrait = window.innerHeight > window.innerWidth;

      let width, height;
      if (isDesktop) {
        width = "500px";
        height = "100vh";
      } else if (isPortrait) {
        width = "100vw";
        height = "100vh";
      } else {
        width = "100vw";
        height = "100vh";
      }

      const elementStyles = {
        width: width,
        height: height,
      };

      setElementStyles(container, elementStyles);
      [cropImgRef, videoRef, boxRef, frameRef].forEach((el) => {
        if (el) setElementStyles(el, elementStyles);
      });
    };

    const generalStyles = {
      position: "absolute",
      top: 0,
      left: 0,
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
      { ...generalStyles, display: "none" },
      container
    );

    videoRef = createElementWithStyles(
      "video",
      "veryfi-video-ref",
      { ...generalStyles, objectFit: "cover" },
      container
    );

    boxRef = createElementWithStyles(
      "canvas",
      "veryfi-box-ref",
      { ...generalStyles, zIndex: 10 },
      container
    );

    updateElementsSize();

    window.addEventListener("resize", updateElementsSize);
    window.addEventListener("orientationchange", updateElementsSize);

    return {
      cleanup: () => {
        window.removeEventListener("resize", updateElementsSize);
        window.removeEventListener("orientationchange", updateElementsSize);
      },
    };
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

  return {
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

    initChecks: async (session, client_id) => {
      isDocumentProcess = true;
      userAgent = navigator.userAgent;
      device_uuid = new DeviceUUID(userAgent).get();

      if (session) {
        lensSessionKey = session;
        createCheckCanvases();
        videoRef = document.getElementById("veryfi-video-ref");
        const video = videoRef;
        video.playsInline = true;
        video.preload = "metadata";
        video.autoplay = true;
        frameRef = document.getElementById("veryfi-frame-ref");
        boxRef = document.getElementById("veryfi-box-ref");
        cropImgRef = document.getElementById("veryfi-crop-img-ref");
        if (client_id) {
          startWasmChecks(client_id);
        } else {
          console.log("No client id provided");
          return;
        }
      } else {
        console.log("No session token provided");
        return;
      }
    },

    startCameraWasm: () => {
      console.log("[EVENT] startCamera");
      startWasm();
    },

    stopCameraWasm: () => {
      console.log("[EVENT] stopCamera");
      stopWasm();
      clearInterval(intervalRef);
    },

    getCardData: async () => {
      return cardData;
    },

    captureWasm: async (setImage, setIsEditing) => {
      console.log("[EVENT] capture wasm");
      // console.log("[EVENT] hasCoordinates: ", hasCoordinates);
      if (hasCoordinates) setIsDocument(true);
      finalImage = await cropWasm();
      setImage && setImage(finalImage);
      stopWasm();
      // wasmWrapper.releaseCallback();
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
      return await createImageBitmap(imageData).then((bitmap) => {
        const wasmOutput = wasmWrapper.cropDocument(bitmap);
        const { data, blurLevel, outputHeight, outputWidth } = wasmOutput;
        // If a document is detected and cropped
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
          wasmWrapper.releaseCallback();
          stopWasm();

          const imgString = cropImgCanvas.toDataURL("image/jpeg");
          image = cropImgCanvas;
          releaseCanvas(boxRef);
          setIsDocument(true);
          coordinates = [];
          return imgString.split("data:image/jpeg;base64,")[1];
        } else {
          // Return the original, uncropped image
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(imageData);
            reader.onload = function () {
              const base64Image = reader.result.split(",")[1];
              resolve(base64Image);
            };
            reader.onerror = function (error) {
              reject(error);
            };
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

    toggleTorch: () => {
      toggleTorchLight();
    },

    getLcdStatus: () => {
      if (wasmWrapper.lcdStatus.LCDProb > 0.5) {
        cardData.cvv = "";
        cardData.date = "";
        cardData.name = "";
        cardData.number = "";
        cardData.status = "";
      }
      return wasmWrapper.lcdStatus();
    },
  };
})();

export default VeryfiLens;
